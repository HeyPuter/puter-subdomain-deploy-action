# Puter Subdomain Deploy Action

Deploys a repository folder (or file) to Puter FS, then ensures a Puter subdomain points at that folder.

This action is bundled into `dist/index.js` and ships with:
- `@heyputer/puter.js`
- `@actions/core`

Runtime: GitHub Actions `node24`.

## Inputs

- `subdomain` (required): Subdomain to manage, such as `my-site` or `my-site.puter.site`
- `puter_path` (required): Destination directory in Puter FS (for example `~/sites/my-site`)
- `puter_token` (required): Puter auth token, usually from `secrets`
- `source_path` (optional, default `.`): Repo-relative file/folder to deploy
- `include_hidden` (optional, default `false`): Include dotfiles/directories
- `concurrency` (optional, default `8`): Number of concurrent uploads

## Outputs

- `deployed_files`: Number of uploaded files
- `deployment_url`: URL in the form `https://<subdomain>.puter.site`
- `binding_action`: `created`, `updated`, or `unchanged`

## What It Does

1. Initializes Puter SDK with your auth token (`@heyputer/puter.js/src/init.cjs`).
2. Ensures `puter_path` exists as a directory.
3. Uploads files from `source_path` using upsert behavior (`puter.fs.write(..., { overwrite: true, createMissingParents: true })`).
4. Reads subdomain mapping with `puter.hosting.get(subdomain)`.
5. Creates subdomain if missing, or updates it if bound to a different directory.

## Usage

```yaml
name: Deploy To Puter

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Deploy website
        id: puter_deploy
        uses: your-org/puter-subdomain-deploy-action@v1
        with:
          subdomain: my-site
          source_path: dist
          puter_path: ~/sites/my-site
          puter_token: ${{ secrets.PUTER_TOKEN }}

      - name: Print URL
        run: echo "Site is live at ${{ steps.puter_deploy.outputs.deployment_url }}"
```

## Local Validation

```bash
npm install
npm run check
npm run build
```

Commit `dist/index.js` after building. GitHub Actions executes that committed bundle directly.

## Publish This Action

1. Push this repo to GitHub (public if you want broad reuse).
2. Create and push a release tag:

```bash
git add .
git commit -m "Release v1.0.0"
git tag v1.0.0
git push origin main --tags
```

3. Create a moving major tag so users can stay on `v1`:

```bash
git tag -f v1 v1.0.0
git push origin -f v1
```

4. In consumer repos, use:

```yaml
uses: your-org/puter-subdomain-deploy-action@v1
```

When you change `src/deploy.mjs`, rebuild before tagging:

```bash
npm run build:clean
git add src/deploy.mjs dist/index.js
git commit -m "Rebuild action bundle"
```

## Publish To GitHub Marketplace (Optional)

1. Open this repository on GitHub.
2. Create a release from your tag (for example `v1.0.0`).
3. On the release page, choose to publish the action to Marketplace and complete the listing form.
