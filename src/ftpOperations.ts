import * as ftp from "basic-ftp";
import { IFtpDeployArgumentsWithDefaults } from "./types";
import { ILogger, ITimings } from "./utilities";

const networkErrors = new Set(["ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "ENOTCONN", "EHOSTUNREACH", "ENETUNREACH"]);
const reconnectReplies = new Set([421, 425, 426]);
const transientReplies = new Set([421, 425, 426, 450, 451]);

// Some connection failures come without an error code, so check their messages too.
function isSocketFailure(error: any): boolean {
    return typeof error?.message === "string" &&
        /^(?:Client is closed because )?(?:Timeout \(|Socket closed due to transmission error \()/.test(error.message);
}

function isRecoverable(error: any): boolean {
    return networkErrors.has(error?.code) || isSocketFailure(error) || error?.name === "TimeoutError" ||
        (typeof error?.code === "number" && transientReplies.has(error.code));
}

function needsReconnect(error: any): boolean {
    return networkErrors.has(error?.code) || isSocketFailure(error) || error?.name === "TimeoutError" ||
        (typeof error?.code === "number" && reconnectReplies.has(error.code));
}

/** Run FTP tasks one at a time. If one fails, earlier tasks stay done. */
export class FtpOperations {
    private root = "";

    constructor(
        readonly client: ftp.Client,
        private readonly args: IFtpDeployArgumentsWithDefaults,
        private readonly logger: ILogger,
        private readonly timings: ITimings
    ) { }

    get rootPath(): string { return this.root; }

    private async open(): Promise<void> {
        this.timings.start("connecting");
        try {
            const secure = this.args.protocol === "ftps" ? true : this.args.protocol === "ftps-legacy" ? "implicit" : false;
            this.client.ftp.verbose = this.args["log-level"] === "verbose";
            await this.client.access({
                host: this.args.server, user: this.args.username, password: this.args.password,
                port: this.args.port, secure,
                secureOptions: { rejectUnauthorized: this.args.security === "strict" }
            });
            this.timings.start("changingDir");
            try {
                await this.client.ensureDir(this.args["server-dir"]);
                this.root = await this.client.pwd();
            }
            finally { this.timings.stop("changingDir"); }
            if (this.args["log-level"] === "verbose") {
                this.client.trackProgress(info => this.logger.verbose(`${info.type} progress for "${info.name}". Progress: ${info.bytes} bytes of ${info.bytesOverall} bytes`));
            }
        }
        finally {
            this.timings.stop("connecting");
        }
    }

    async connect(): Promise<void> {
        await this.run("connect", async () => this.open(), false);
    }

    async run<T>(name: string, operation: () => Promise<T>, connected = true): Promise<T> {
        let reconnect = false;
        for (let attempt = 0; ; attempt++) {
            try {
                if (reconnect) {
                    this.client.close();
                    if (connected) { await this.open(); }
                }
                return await operation();
            }
            catch (error: any) {
                if (attempt >= this.args["max-retries"] || !isRecoverable(error)) {
                    throw error;
                }
                reconnect = !connected || needsReconnect(error) || this.client.closed;
                const delay = Math.min(30000, this.args["retry-delay"] * Math.pow(2, Math.min(attempt, 30)));
                this.logger.standard(`${name} failed (${error.code ?? error.name}); retry ${attempt + 1}/${this.args["max-retries"]} in ${delay}ms${reconnect ? " after reconnecting" : ""}`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    /** If a delete fails, check whether the file is already gone. If not, throw an error. */
    async removeFile(path: string): Promise<void> {
        await this.run(`remove ${path}`, async () => {
            try {
                await this.client.remove(path);
            }
            catch (error: any) {
                if (error?.code !== 550) { throw error; }
                const entries = await this.client.list(path.substring(0, path.lastIndexOf("/")) || ".");
                const name = path.substring(path.lastIndexOf("/") + 1);
                if (entries.some(entry => entry.name === name)) { throw error; }
            }
        });
    }

    /** If a delete fails, check whether the folder is already gone. If not, throw an error. */
    async removeFolder(path: string): Promise<void> {
        const normalized = path.replace(/\/$/, "");
        await this.run(`remove folder ${path}`, async () => {
            try {
                await this.client.removeDir(normalized);
            }
            catch (error: any) {
                if (error?.code !== 550) { throw error; }
                const parent = normalized.substring(0, normalized.lastIndexOf("/")) || "/";
                const name = normalized.substring(normalized.lastIndexOf("/") + 1);
                const entries = await this.client.list(parent);
                if (entries.some(entry => entry.name === name)) { throw error; }
            }
        });
    }
}
