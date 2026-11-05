import fs from "fs";
import os from "os";
import path from "path";
import FtpSrv from "ftp-srv";
import * as ftp from "basic-ftp";
import { FtpOperations } from "./ftpOperations";
import { getDefaultSettings, ILogger, Timings } from "./utilities";
import { getServerFiles } from "./deploy";
import { FTPSyncProvider } from "./syncProvider";
import { DiffResult } from "./types";
import { deploy } from "./module";

const logger: ILogger = { all() { }, standard() { }, verbose() { } };
const args = () => getDefaultSettings({ server: "localhost", username: "user", password: "pass", "server-dir": "./public/", "max-retries": 2, "retry-delay": 0 });
const dropped = () => Object.assign(new Error("connection reset"), { code: "ECONNRESET" });

function mockClient() {
    return {
        closed: false,
        ftp: { verbose: false },
        access: jest.fn(async () => undefined),
        ensureDir: jest.fn(async () => undefined),
        pwd: jest.fn(async () => "/public"),
        close: jest.fn(),
        trackProgress: jest.fn(),
        list: jest.fn(async () => [] as { name: string }[]),
        uploadFrom: jest.fn<Promise<void>, [string, string]>(async () => { }),
        rename: jest.fn(async () => undefined),
        cd: jest.fn(async () => undefined),
        remove: jest.fn(async () => undefined)
    };
}

describe("deployment-scoped FTP recovery", () => {
    test("reconnects, restores the remote root, and retries only the interrupted file", async () => {
        const client = mockClient();
        const operations = new FtpOperations(client as any, args(), logger, new Timings());
        await operations.connect();
        let calls = 0;
        client.uploadFrom.mockImplementation(async () => {
            calls++;
            if (calls === 2) { throw dropped(); }
        });
        await operations.run("first file", async () => client.uploadFrom("one", "/public/one"));
        await operations.run("second file", async () => client.uploadFrom("two", "/public/two"));
        expect(client.uploadFrom.mock.calls.map(call => call[0])).toEqual(["one", "two", "two"]);
        expect(client.access).toHaveBeenCalledTimes(2);
        expect(client.ensureDir).toHaveBeenNthCalledWith(2, "./public/");
        expect(operations.rootPath).toBe("/public");
    });

    test("bounds retries; does not retry permanent errors", async () => {
        const client = mockClient();
        const operations = new FtpOperations(client as any, args(), logger, new Timings());
        await operations.connect();
        const fail = jest.fn(async () => { throw dropped(); });
        await expect(operations.run("broken", fail)).rejects.toMatchObject({ code: "ECONNRESET" });
        expect(fail).toHaveBeenCalledTimes(3);
        const unauthorized = jest.fn(async () => { throw Object.assign(new Error("denied"), { code: 530 }); });
        await expect(operations.run("denied", unauthorized)).rejects.toMatchObject({ code: 530 });
        expect(unauthorized).toHaveBeenCalledTimes(1);
        const timeout = jest.fn(async () => { throw new Error("Timeout (control socket)"); });
        await expect(operations.run("timeout", timeout)).rejects.toThrow("Timeout");
        expect(timeout).toHaveBeenCalledTimes(3);
    });

    test("retries when basic-ftp reports an unexpected FIN", async () => {
        const client = mockClient();
        const operations = new FtpOperations(client as any, args(), logger, new Timings());
        await operations.connect();
        const operation = jest.fn()
            .mockRejectedValueOnce(new Error("Server sent FIN packet unexpectedly, closing connection."))
            .mockResolvedValue("recovered");

        await expect(operations.run("create folder", operation)).resolves.toBe("recovered");
        expect(operation).toHaveBeenCalledTimes(2);
        expect(client.access).toHaveBeenCalledTimes(2);
    });

    test("server state list errors do not masquerade as a first publish", async () => {
        const client = mockClient();
        const options = args();
        const operations = new FtpOperations(client as any, options, logger, new Timings());
        await operations.connect();
        client.list.mockRejectedValue(dropped());
        await expect(getServerFiles(client as any, logger, new Timings(), options, operations)).rejects.toMatchObject({ code: "ECONNRESET" });
    });

    test("invalid state is rejected instead of deleting or reuploading everything", async () => {
        const client = mockClient();
        const options = args();
        const operations = new FtpOperations(client as any, options, logger, new Timings());
        await operations.connect();
        client.list.mockResolvedValue([{ name: options["state-name"] }]);
        (client as any).downloadTo = jest.fn(async (target: string) => { fs.writeFileSync(target, "{invalid json"); });
        await expect(getServerFiles(client as any, logger, new Timings(), options, operations)).rejects.toThrow();
    });

    test("failed file upload prevents final state publication", async () => {
        const client = mockClient();
        const options = args();
        options["max-retries"] = 0;
        const operations = new FtpOperations(client as any, options, logger, new Timings());
        await operations.connect();
        client.uploadFrom.mockRejectedValue(dropped());
        const provider = new FTPSyncProvider(client as any, logger, new Timings(), "./", options["server-dir"], options["state-name"], false, operations);
        const diffs: DiffResult = {
            upload: [{ type: "file", name: "a", size: 1, hash: "a" }], delete: [], replace: [], same: [],
            sizeUpload: 1, sizeDelete: 0, sizeReplace: 0
        };
        await expect(provider.syncLocalToServer(diffs)).rejects.toMatchObject({ code: "ECONNRESET" });
        expect(client.rename).not.toHaveBeenCalled();
    });

    test("validates retry and timeout parameters", () => {
        expect(() => getDefaultSettings({ server: "a", username: "b", password: "c", "max-retries": -1 })).toThrow();
        expect(() => getDefaultSettings({ server: "a", username: "b", password: "c", "retry-delay": NaN })).toThrow();
        expect(() => getDefaultSettings({ server: "a", username: "b", password: "c", timeout: 0 })).toThrow();
    });

    test("publishes files and replaces the manifest on a real FTP server", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "ftp-deploy-integration-"));
        const local = path.join(root, "local");
        const remote = path.join(root, "remote");
        fs.mkdirSync(local);
        fs.mkdirSync(remote);
        fs.mkdirSync(path.join(local, "nested"));
        fs.writeFileSync(path.join(local, "nested", "first.txt"), "first");
        fs.writeFileSync(path.join(local, "nested", "second.txt"), "second");
        const port = 22182;
        const server = new FtpSrv({ url: `ftp://127.0.0.1:${port}`, pasv_url: "127.0.0.1", anonymous: true });
        server.on("login", (_data, resolve) => resolve({ root: remote }));
        try {
            await server.listen();
            const options = {
                server: "127.0.0.1", port, username: "user", password: "pass",
                "local-dir": `${local.replace(/\\/g, "/")}/`, "server-dir": "./site/",
                "state-name": "nested/.sync-state.json", "log-level": "minimal" as const, "retry-delay": 0
            };
            const originalUpload = ftp.Client.prototype.uploadFrom;
            const uploadedPaths: string[] = [];
            const uploadSpy = jest.spyOn(ftp.Client.prototype, "uploadFrom").mockImplementation(async function (this: ftp.Client, source, target, uploadOptions) {
                uploadedPaths.push(target);
                if (uploadedPaths.length === 2) {
                    this.close();
                    throw dropped();
                }
                return originalUpload.call(this, source, target, uploadOptions);
            });
            try { await deploy(options); }
            finally { uploadSpy.mockRestore(); }
            expect(uploadedPaths.filter(target => target.endsWith("first.txt"))).toHaveLength(1);
            expect(uploadedPaths.filter(target => target.endsWith("second.txt"))).toHaveLength(2);
            expect(fs.readFileSync(path.join(remote, "site", "nested", "first.txt"), "utf8")).toBe("first");
            expect(fs.readFileSync(path.join(remote, "site", "nested", "second.txt"), "utf8")).toBe("second");
            const manifest = path.join(remote, "site", "nested", ".sync-state.json");
            const backup = `${manifest}.backup`;
            fs.renameSync(manifest, backup); // Pretend the connection dropped after saving the old state.
            fs.writeFileSync(path.join(local, "nested", "first.txt"), "changed");
            await deploy(options);
            expect(fs.readFileSync(path.join(remote, "site", "nested", "first.txt"), "utf8")).toBe("changed");
            expect(fs.existsSync(manifest)).toBe(true);
            expect(fs.existsSync(backup)).toBe(false);
            fs.writeFileSync(path.join(local, "nested", "first.txt"), "third");
            await deploy(options);
            expect(fs.readFileSync(path.join(remote, "site", "nested", "first.txt"), "utf8")).toBe("third");
            expect(fs.existsSync(manifest)).toBe(true);
            expect(fs.existsSync(backup)).toBe(false);
        }
        finally {
            await server.close();
            fs.rmSync(root, { recursive: true, force: true });
        }
    }, 30000);
});
