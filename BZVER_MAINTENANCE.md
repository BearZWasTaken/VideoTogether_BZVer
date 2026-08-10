# VideoTogether_BZVer Maintenance

This fork keeps the official VideoTogether repository as `upstream` and your own GitHub repository as `origin`.

## Remotes

```powershell
git remote -v
```

Expected layout:

```text
origin    https://github.com/BearZWasTaken/VideoTogether_BZVer.git
upstream  https://github.com/VideoTogether/VideoTogether.git
```

`upstream` is for fetching official changes only. Its push URL is intentionally disabled to avoid accidentally pushing to the official repository.

## First Push

Create an empty GitHub repository named `VideoTogether_BZVer`, then run:

```powershell
git push -u origin main
```

## Sync Official Updates

Use this flow when you want to follow official VideoTogether updates while keeping BZVer features:

```powershell
git fetch upstream
git checkout main
git merge upstream/main
python script\build_extension.py disable_network
git status
git add -A
git commit
git push origin main
```

If Git reports conflicts during `git merge upstream/main`, resolve the conflicted files, run the build script again, then commit the merge.

## Notes

- Prefer `merge` over `rebase` for routine upstream updates, because it preserves the history of BZVer changes and makes conflict resolution safer.
- Keep feature changes in source files first, then run `python script\build_extension.py disable_network` to regenerate browser/release outputs.
- Do not commit the nested helper repositories under `source/local/`, `source/setting/`, or `source/website/`.
