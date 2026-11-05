# ftp deploy 🚀

Syncs a local folder with a remote folder over ftp.

After the initial sync only differences are synced, making deployments super fast!

[![Latest Stable Version](https://img.shields.io/npm/v/@samkirkland/ftp-deploy.svg?style=flat-square)](https://www.npmjs.com/package/@samkirkland/ftp-deploy)
[![NPM Downloads](https://img.shields.io/npm/dt/@samkirkland/ftp-deploy.svg?style=flat-square)](https://www.npmjs.com/package/@samkirkland/ftp-deploy)

---

## How to Run
#### Option 1 - Run via command line
- Install the npm package using `npm install @samkirkland/ftp-deploy --only=dev`
- Run via command line `ftp-deploy --server ftp.samkirkland.com --username test@samkirkland.com --password \"CrazyUniquePassword&%123\"`

- **Or you can add a script to make deployments easier**
- Add a new key to your `package.json` file under `scripts` section. See example below.
- You can run the script using the following command `npm run deploy` (run this in the folder that has the `package.json` file)

Example of `package.json`:
```json
{
  "scripts": {
    "deploy": "ftp-deploy --server ftp.samkirkland.com --username test@samkirkland.com --password \"CrazyUniquePassword&%123\"",
  },
}
```

#### Option 2 - Run programmatically
- Install the npm package using `npm install @samkirkland/ftp-deploy --only=dev`
- Import the code and use it in your code

Example of `myCustomDeployment.js`:
```javascript
import { deploy, excludeDefaults } from "@samkirkland/ftp-deploy";

async function deployMyCode() {
  console.log("🚚 Deploy started");
  await deploy({
    server: "ftp.samkirkland.com",
    username: "username@samkirkland.com",
    password: `CrazyUniquePassword&%123`, // note: I'm using backticks here ` so I don't have to escape quotes
    exclude: [...excludeDefaults, "dontDeployThisFolder/**"] // excludeDefaults will exclude .git files and node_modules
  });
  console.log("🚀 Deploy done!");
}

deployMyCode();

```

### Automatically Deploying
If you use github as source control you can automatically re-deploy your site on every git commit. [Read more](https://github.com/SamKirkland/FTP-Deploy-Action)

### First deployment with many files

Uploading thousands of files over FTP can be slow. This option makes one ZIP containing your files and the state file used for later deployments, then uploads the ZIP over FTP. You extract it with your host's file manager; FTP cannot extract ZIPs.

```sh
ftp-deploy --server ftp.example.com --username user --password pass --local-dir ./site/ --server-dir ./public_html/ --archive-output ./bootstrap.zip
```

If `--server-dir` already has files, the command warns but continues. Extracting the ZIP may overwrite same-named files; other existing files remain on the server and are not added to the sync state. Back up anything important first. Save the local ZIP **outside** `--local-dir` (if `--local-dir` is `./`, choose an output path outside the current folder). Use the same `--local-dir`, `--server-dir`, `--exclude`, and `--state-name` settings in later deployments. The command will not overwrite an existing local ZIP.

1. Find the ZIP in `--server-dir` using the name printed by the command. Its name includes the date, time, a unique suffix, and the GitHub run ID if available.
2. Extract its contents **directly into `--server-dir`**, not a new subfolder. Check that all files and the state file were extracted. If extraction fails, remove the partly extracted files (including the state file) and start again with an empty directory.
3. Delete the ZIP from the server. It could be downloadable if left in a public website folder.
4. Run future deployments normally, **without** `--archive-output`. Unchanged files will be skipped.

If upload fails, delete any partial ZIP on the server and the local output ZIP before retrying. Keep files unchanged while building the ZIP, allow enough space for it locally and on the server, and prefer `--protocol ftps` for an encrypted transfer. Do not run another deployment until extraction finishes.

### Use this recovery fork as a GitHub Action

This repository includes a composite GitHub Action with the same core inputs used by the original FTP Deploy Action, plus `max-retries` and `retry-delay`. To switch an existing workflow, change only the `uses` reference to this repository and a release tag; keep your existing `with` settings:

```yaml
- name: Deploy to FTP
  uses: Hanzyusuf/ftp-deploy@v1.2.8
  with:
    server: ${{ secrets.FTP_SERVER }}
    username: ${{ secrets.FTP_USERNAME }}
    password: ${{ secrets.FTP_PASSWORD }}
    protocol: ftps
    local-dir: ./dist/
    server-dir: ./public_html/
    max-retries: 5
    retry-delay: 1000
```

Replace the example tag with a tag you have pushed to this fork. Add any FTP values used by your existing workflow (such as `port`, `exclude`, or `state-name`) unchanged. The action builds this repository's CLI at runtime, so it needs Node.js/npm and network access to install the locked dependencies.

---

## Settings

To list all commands with examples simply run `ftp-deploy` without any options.

| Key Name                  | Required | Example                    | Default Value                                 | Description                                                                                                                                                        |
|---------------------------|----------|----------------------------|-----------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `--server`                | Yes      | `ftp.samkirkland.com`      |                                               | Deployment destination server                                                                                                                                      |
| `--username`              | Yes      | `username@samkirkland.com` |                                               | ftp username                                                                                                                                                       |
| `--password`              | Yes      | `CrazyUniquePassword&%123` |                                               | ftp password, be sure to escape quotes and spaces                                                                                                                  |
| `--port`                  | No       | `990`                      | `21`                                          | Server port to connect to (read your web hosts docs)                                                                                                               |
| `--protocol`              | No       | `ftps`                     | `ftp`                                         | `ftp`: provides no encryption, `ftps`: full encryption newest standard (aka "explicit" ftps), `ftps-legacy`: full encryption legacy standard (aka "implicit" ftps) |
| `--local-dir`             | No       | `./myFolderToPublish/`     | `./`                                          | Local folder to upload from, must end with trailing slash `/`                                                                                                       |
| `--server-dir`            | No       | `./public_html/`           | `./`                                          | Server folder to upload into, must end with trailing slash `/`                                                                                                      |
| `--state-name`            | No       | `folder/.sync-state.json`  | `.ftp-deploy-sync-state.json`                 | ftp-deploy uses this file to track what's been deployed already, so only differences can be published. If you don't like the name or location you can customize it |
| `--archive-output`        | No       | `./bootstrap.zip`          |                                               | Save and upload a ZIP with the files and sync state; extract it on the server with your host's file manager (warns if server-dir has files) |
| `--dry-run`               | No       | `true`                     | `false`                                       | Prints which modifications will be made with current config options, but doesn't actually make any changes                                                         |
| `--dangerous-clean-slate` | No       | `true`                     | `false`                                       | Deletes ALL contents of server-dir, even items marked as `--exclude` argument                                                                                      |
| `--exclude`               | No       | `nuclearLaunchCodes.txt`   | `**/.git*` `**/.git*/**` `**/node_modules/**` | An array of glob patterns, these files will not be included in the publish/delete process                                                                          |
| `--log-level`             | No       | `standard`                 | `standard`                                    | `minimal`: only important info, `standard`: important info and basic file changes, `verbose`: print everything the script is doing                                 |
| `--security`              | No       | `strict`                   | `loose`                                       | `strict`: Reject any connection which is not authorized with the list of supplied CAs. `loose`: Allow connection even when the domain is not in certificate        |
| `--timeout`               | No       | `60000`                    | `30000`                                       | Timeout in milliseconds for FTP operations                                                                                                                         |
| `--max-retries`           | No       | `10`                       | `5`                                           | Times to retry a failed FTP action; `0` turns retries off                                                                                                           |
| `--retry-delay`           | No       | `2000`                     | `1000`                                        | Wait before the first retry, in milliseconds. The wait doubles each time, up to 30 seconds                                                                          |

### What happens if the connection drops?

- The deployer reconnects and tries the interrupted file again. Files that finished earlier in this run are not uploaded again.
- If it cannot reconnect after the allowed retries, the deployment stops. Files already uploaded stay on the server; FTP cannot undo them.
- Starting a new deployment does **not** resume the old one. It checks the last saved state, so it may upload some of the same files again.
- The state file is saved only when the deployment finishes. If saving it is interrupted, the old state is kept as a backup for the next run.

The configured state filename, its `.backup` file, and `.upload-*` files with the same name are used internally. Do not use those names for your own files.
