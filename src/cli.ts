#! /usr/bin/env node

import { deploy, excludeDefaults } from "./module";
import yargs from "yargs";
import { IFtpDeployArguments } from "./types";
import { prepareArchive, uploadArchive } from "./archiveBootstrap";

const argv = yargs.options({
    "server": { type: "string", demandOption: true },
    "username": { type: "string", demandOption: true },
    "password": { type: "string", demandOption: true },
    "port": { type: "number", default: 21 },
    "protocol": { choices: ["ftp", "ftps", "ftps-legacy"], default: "ftp" },
    "local-dir": { type: "string", default: "./" },
    "server-dir": { type: "string", default: "./" },
    "state-name": { type: "string", default: ".ftp-deploy-sync-state.json" },
    "archive-output": { type: "string", description: "Save a ZIP locally and upload it to an empty server-dir; extract it in your host's file manager" },
    "dry-run": { type: "boolean", default: false, description: "Prints which modifications will be made with current config options, but doesn't actually make any changes" },
    "dangerous-clean-slate": { type: "boolean", default: false, description: "Deletes ALL contents of server-dir, even items in excluded with 'exclude' argument" },
    "exclude": { type: "array", default: excludeDefaults, description: "An array of glob patterns, these files will not be included in the publish/delete process" },
    "log-level": { choices: ["minimal", "standard", "verbose"], default: "standard", description: "How much information should print. minimal=only important info, standard=important info and basic file changes, verbose=print everything the script is doing" },
    "security": { choices: ["strict", "loose"], default: "loose", description: "" },
    "timeout": { type: "number", default: 30000, description: "FTP operation timeout in milliseconds" },
    "max-retries": { type: "number", default: 5, description: "Retries after recoverable connection errors (0 disables retries)" },
    "retry-delay": { type: "number", default: 1000, description: "Initial retry delay in milliseconds; exponential backoff capped at 30 seconds" }
})
    .example("$0 --server ftp://samkirkland.com --username user --password pass", "")
    .help("help")
    .epilog("Read more at https://github.com/SamKirkland/FTP-Deploy-Action")
    .argv;


async function runScript() {
    const args = await argv;
    if (args["archive-output"]) {
        if (args["dry-run"] || args["dangerous-clean-slate"]) { throw new Error("Archive mode cannot be combined with dry-run or dangerous-clean-slate"); }
        const state = await prepareArchive(args["archive-output"], {
            "local-dir": args["local-dir"], "state-name": args["state-name"], exclude: args.exclude as string[]
        });
        const remoteName = await uploadArchive(args["archive-output"], args as IFtpDeployArguments);
        console.log(`Uploaded ${remoteName} to ${args["server-dir"]}: ${state.data.length} files/folders and ${args["state-name"]} are inside. Extract it directly into ${args["server-dir"]} with your host's file manager, verify extraction, and delete the ZIP before running the next FTP deployment.`);
        return;
    }
    await deploy(args as IFtpDeployArguments);
}


runScript().catch(error => { console.error(error); process.exitCode = 1; });
