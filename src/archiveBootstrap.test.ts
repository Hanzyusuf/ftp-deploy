import fs from "fs";
import os from "os";
import path from "path";
import yauzl from "yauzl";
import FtpSrv from "ftp-srv";
import * as ftp from "basic-ftp";
import { prepareArchive, uploadArchive } from "./archiveBootstrap";
import { HashDiff } from "./HashDiff";
import { getLocalFiles } from "./localFiles";
import { getDefaultSettings } from "./utilities";
import { IFileList } from "./types";
import { deploy } from "./module";

async function entriesInZip(filename: string): Promise<Map<string, Buffer>> {
    return new Promise((resolve, reject) => {
        yauzl.open(filename, { lazyEntries: true }, (error, zip) => {
            if (error || !zip) { reject(error); return; }
            const entries = new Map<string, Buffer>();
            zip.on("error", reject);
            zip.on("end", () => resolve(entries));
            zip.on("entry", entry => {
                zip.openReadStream(entry, (streamError, stream) => {
                    if (streamError || !stream) { reject(streamError); return; }
                    const buffers: Buffer[] = [];
                    stream.on("error", reject);
                    stream.on("data", chunk => buffers.push(chunk));
                    stream.on("end", () => { entries.set(entry.fileName, Buffer.concat(buffers)); zip.readEntry(); });
                });
            });
            zip.readEntry();
        });
    });
}

describe("manual archive bootstrap", () => {
    let root: string;
    let local: string;
    let output: string;
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "ftp-archive-test-"));
        local = path.join(root, "site");
        output = path.join(root, "bootstrap.zip");
        fs.mkdirSync(local);
        fs.mkdirSync(path.join(local, "nested"));
        fs.mkdirSync(path.join(local, "empty"));
        fs.writeFileSync(path.join(local, "nested", "hello.txt"), "hello");
        fs.writeFileSync(path.join(local, "secret.txt"), "ignored");
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    test("ZIP contains exactly the deployable files, empty folders and valid state; subsequent diff is empty", async () => {
        const opts = { "local-dir": local.replace(/\\/g, "/") + "/", "state-name": "meta/state.json", exclude: ["secret.txt"] };
        const state = await prepareArchive(output, opts);
        const entries = await entriesInZip(output);
        expect([...entries.keys()].sort((a, b) => a.localeCompare(b))).toEqual(["empty/", "meta/state.json", "nested/", "nested/hello.txt"]);
        expect(entries.get("nested/hello.txt")!.toString()).toBe("hello");
        const saved = JSON.parse(entries.get("meta/state.json")!.toString()) as IFileList;
        expect(saved).toEqual(state);
        expect(saved.data.map(item => item.name)).not.toContain("meta/state.json");
        expect(saved.data.map(item => item.name)).not.toContain("bootstrap.zip");
        const current = await getLocalFiles(getDefaultSettings({ server: "", username: "", password: "", ...opts }));
        expect(new HashDiff().getDiffs(current, saved).upload).toHaveLength(0);
        fs.writeFileSync(path.join(local, "nested", "hello.txt"), "changed");
        const changed = await getLocalFiles(getDefaultSettings({ server: "", username: "", password: "", ...opts }));
        expect(new HashDiff().getDiffs(changed, saved).replace.map(item => item.name)).toEqual(["nested/hello.txt"]);
    });

    test("rejects output inside source and existing output without modifying them", async () => {
        await expect(prepareArchive(path.join(local, "out.zip"), { "local-dir": local.replace(/\\/g, "/") + "/" })).rejects.toThrow("outside local-dir");
        fs.writeFileSync(output, "original");
        await expect(prepareArchive(output, { "local-dir": local.replace(/\\/g, "/") + "/" })).rejects.toThrow("already exists");
        expect(fs.readFileSync(output, "utf8")).toBe("original");
    });

    test("rejects state-name colliding with content", async () => {
        await expect(prepareArchive(output, { "local-dir": local.replace(/\\/g, "/") + "/", "state-name": "secret.txt/state.json" })).rejects.toThrow("collides");
        expect(fs.existsSync(output)).toBe(false);
    });

    test("uploads only the ZIP over FTP and normal deployment skips files after manual extraction", async () => {
        const remote = path.join(root, "remote");
        fs.mkdirSync(remote);
        const port = 22184;
        const server = new FtpSrv({ url: `ftp://127.0.0.1:${port}`, pasv_url: "127.0.0.1", anonymous: true });
        server.on("login", (_data, resolve) => resolve({ root: remote }));
        const options = {
            server: "127.0.0.1", port, username: "user", password: "pass",
            "local-dir": local.replace(/\\/g, "/") + "/", "server-dir": "./site/",
            "log-level": "minimal" as const, "retry-delay": 0
        };
        try {
            await server.listen();
            await prepareArchive(output, { "local-dir": options["local-dir"] });
            const name = await uploadArchive(output, options);
            expect(name).toMatch(/^ftp-deploy-bootstrap-\d{8}T\d{6}Z(?:-run-\d+)?-[a-f0-9]{12}\.zip$/);
            const destination = path.join(remote, "site");
            expect(fs.readdirSync(destination)).toEqual([name]);
            await expect(uploadArchive(output, options)).rejects.toThrow("empty server-dir");

            // Simulate a completed Hostinger file-manager extraction, then remove the ZIP.
            for (const [entry, contents] of await entriesInZip(path.join(destination, name))) {
                const target = path.join(destination, ...entry.split("/"));
                if (entry.endsWith("/")) { fs.mkdirSync(target, { recursive: true }); }
                else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, contents); }
            }
            fs.rmSync(path.join(destination, name));
            const uploadSpy = jest.spyOn(ftp.Client.prototype, "uploadFrom");
            try { await deploy(options); }
            finally { uploadSpy.mockRestore(); }
            expect(uploadSpy.mock.calls.some(call => String(call[1]).endsWith("nested/hello.txt"))).toBe(false);
            expect(fs.readFileSync(path.join(destination, "nested", "hello.txt"), "utf8")).toBe("hello");
        }
        finally { await server.close(); }
    });
});
