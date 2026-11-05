import prettyBytes from "pretty-bytes";
import type * as ftp from "basic-ftp";
import { DiffResult, ErrorCode, IFilePath } from "./types";
import { ILogger, pluralize, retryRequest, ITimings } from "./utilities";
import { FtpOperations } from "./ftpOperations";
import path from "path";

export async function ensureDir(client: ftp.Client, logger: ILogger, timings: ITimings, folder: string): Promise<void> {
    timings.start("changingDir");
    logger.verbose(`  changing dir to ${folder}`);

    await retryRequest(logger, async () => await client.ensureDir(folder));

    logger.verbose(`  dir changed`);
    timings.stop("changingDir");
}

interface ISyncProvider {
    createFolder(folderPath: string): Promise<void>;
    removeFile(filePath: string): Promise<void>;
    removeFolder(folderPath: string): Promise<void>;

    /**
     * @param file file can include folder(s)
     * Note working dir is modified and NOT reset after upload
     * For now we are going to reset it - but this will be removed for performance
     */
    uploadFile(filePath: string, type: "upload" | "replace"): Promise<void>;

    syncLocalToServer(diffs: DiffResult): Promise<void>;
}

export class FTPSyncProvider implements ISyncProvider {
    constructor(client: ftp.Client, logger: ILogger, timings: ITimings, localPath: string, serverPath: string, stateName: string, dryRun: boolean, operations?: FtpOperations) {
        this.client = client;
        this.logger = logger;
        this.timings = timings;
        this.localPath = localPath;
        this.serverPath = serverPath;
        this.stateName = stateName;
        this.dryRun = dryRun;
        this.operations = operations;
    }

    private client: ftp.Client;
    private logger: ILogger;
    private timings: ITimings;
    private localPath: string;
    private serverPath: string;
    private dryRun: boolean;
    private stateName: string;
    private operations?: FtpOperations;

    private async run(name: string, callback: () => Promise<unknown>): Promise<void> {
        if (this.operations) { await this.operations.run(name, callback); }
        else { await retryRequest(this.logger, callback); }
    }

    private remotePath(name: string): string {
        return this.operations ? `${this.operations.rootPath.replace(/\/$/, "")}/${name}` : name;
    }


    /**
     * Converts a file path (ex: "folder/otherfolder/file.txt") to an array of folder and a file path
     * @param fullPath
     */
    private getFileBreadcrumbs(fullPath: string): IFilePath {
        // todo see if this regex will work for nonstandard folder names
        // todo what happens if the path is relative to the root dir? (starts with /)
        const pathSplit = fullPath.split("/");
        const file = pathSplit?.pop() ?? ""; // get last item
        const folders = pathSplit.filter(folderName => folderName != "");

        return {
            folders: folders.length === 0 ? null : folders,
            file: file === "" ? null : file
        };
    }

    /**
     * Navigates up {dirCount} number of directories from the current working dir
     */
    private async upDir(dirCount: number | null | undefined): Promise<void> {
        if (typeof dirCount !== "number") {
            return;
        }

        // navigate back to the starting folder
        for (let i = 0; i < dirCount; i++) {
            await retryRequest(this.logger, async () => await this.client.cdup());
        }
    }

    async createFolder(folderPath: string) {
        this.logger.all(`creating folder "${folderPath + "/"}"`);

        if (this.dryRun === true) {
            return;
        }

        const path = this.getFileBreadcrumbs(folderPath + "/");

        if (path.folders === null) {
            this.logger.verbose(`  no need to change dir`);
        }
        else {
            if (this.operations) {
                await this.run(`create folder ${folderPath}`, async () => {
                    await this.client.ensureDir(this.remotePath(path.folders!.join("/")));
                    await this.client.cd(this.operations!.rootPath);
                });
            }
            else { await ensureDir(this.client, this.logger, this.timings, path.folders.join("/")); }
        }

        // navigate back to the root folder
        if (!this.operations) { await this.upDir(path.folders?.length); }

        this.logger.verbose(`  completed`);
    }

    async removeFile(filePath: string) {
        this.logger.all(`removing "${filePath}"`);

        if (this.dryRun === false) {
            try {
                if (this.operations) { await this.operations.removeFile(this.remotePath(filePath)); }
                else { await retryRequest(this.logger, async () => await this.client.remove(filePath)); }
            }
            catch (e: any) {
                if (this.operations) { throw e; }
                // this error is common when a file was deleted on the server directly
                if (e?.code === ErrorCode.FileNotFoundOrNoAccess) {
                    this.logger.standard("File not found or you don't have access to the file - skipping...");
                }
                else {
                    throw e;
                }
            }
        }
        this.logger.verbose(`  file removed`);

        this.logger.verbose(`  completed`);
    }

    async removeFolder(folderPath: string) {
        const absoluteFolderPath = this.operations ? this.remotePath(folderPath) : "/" + (this.serverPath.startsWith("./") ? this.serverPath.replace("./", "") : this.serverPath) + folderPath;
        this.logger.all(`removing folder "${absoluteFolderPath}"`);

        if (this.dryRun === false) {
            try {
                if (this.operations) { await this.operations.removeFolder(absoluteFolderPath); }
                else { await this.run(`remove folder ${folderPath}`, async () => this.client.removeDir(absoluteFolderPath)); }
            }
            catch (e: any) {
                if (this.operations) { throw e; }
                if (e?.code === ErrorCode.FileNotFoundOrNoAccess) {
                    this.logger.standard("Directory not found or you don't have access to the file - skipping...");
                }
                else {
                    throw e;
                }
            }
        }

        this.logger.verbose(`  completed`);
    }

    async uploadFile(filePath: string, type: "upload" | "replace" = "upload") {
        const typePresent = type === "upload" ? "uploading" : "replacing";
        const typePast = type === "upload" ? "uploaded" : "replaced";
        this.logger.all(`${typePresent} "${filePath}"`);

        if (this.dryRun === false) {
            await this.run(`upload ${filePath}`, async () => this.client.uploadFrom(this.localPath + filePath, this.remotePath(filePath)));
        }

        this.logger.verbose(`  file ${typePast}`);
    }

    async syncLocalToServer(diffs: DiffResult) {
        const totalCount = diffs.delete.length + diffs.upload.length + diffs.replace.length;

        this.logger.all(`----------------------------------------------------------------`);
        this.logger.all(`Making changes to ${totalCount} ${pluralize(totalCount, "file/folder", "files/folders")} to sync server state`);
        this.logger.all(`Uploading: ${prettyBytes(diffs.sizeUpload)} -- Deleting: ${prettyBytes(diffs.sizeDelete)} -- Replacing: ${prettyBytes(diffs.sizeReplace)}`);
        this.logger.all(`----------------------------------------------------------------`);

        // create new folders
        for (const file of diffs.upload.filter(item => item.type === "folder")) {
            await this.createFolder(file.name);
        }

        // upload new files
        for (const file of diffs.upload.filter(item => item.type === "file").filter(item => item.name !== this.stateName)) {
            await this.uploadFile(file.name, "upload");
        }

        // replace new files
        for (const file of diffs.replace.filter(item => item.type === "file").filter(item => item.name !== this.stateName)) {
            // note: FTP will replace old files with new files. We run replacements after uploads to limit downtime
            await this.uploadFile(file.name, "replace");
        }

        // delete old files
        for (const file of diffs.delete.filter(item => item.type === "file")) {
            await this.removeFile(file.name);
        }

        // delete old folders
        for (const file of diffs.delete.filter(item => item.type === "folder")) {
            await this.removeFolder(file.name);
        }

        this.logger.all(`----------------------------------------------------------------`);
        this.logger.all(`Saving current server state to "${this.serverPath + this.stateName}"`);
        if (this.dryRun === false) {
            if (!this.operations) {
                await retryRequest(this.logger, async () => await this.client.uploadFrom(this.localPath + this.stateName, this.stateName));
            }
            else {
                // Upload under a new name first, so a failed upload leaves the old state alone.
                const temporary = `${this.stateName}.upload-${process.pid}-${Date.now()}`;
                const backup = `${this.stateName}.backup`;
                await this.run("upload temporary server state", async () => this.client.uploadFrom(this.localPath + this.stateName, this.remotePath(temporary)));
                const directory = this.remotePath(path.posix.dirname(this.stateName));
                const entries = await this.operations.run("inspect server state", async () => this.client.list(directory));
                const backupExists = entries.some(entry => entry.name === path.posix.basename(backup));
                if (entries.some(entry => entry.name === path.posix.basename(this.stateName))) {
                    // Keep the backup if an earlier attempt did not finish.
                    if (backupExists) { throw new Error("Server state backup already exists; refusing to overwrite the recovery state"); }
                    await this.run("backup server state", async () => this.client.rename(this.remotePath(this.stateName), this.remotePath(backup)));
                }
                await this.run("publish server state", async () => this.client.rename(this.remotePath(temporary), this.remotePath(this.stateName)));
                if (backupExists || entries.some(entry => entry.name === path.posix.basename(this.stateName))) {
                    await this.operations.removeFile(this.remotePath(backup));
                }
            }
        }
        this.logger.all(`🎉 Sync complete.`);
    }
}
