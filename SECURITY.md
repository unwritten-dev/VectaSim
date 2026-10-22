# Security policy

## Supported versions

VectaSim is in beta. Security fixes go into the latest release only. The built-in updater (*Settings → Updates*, also checked at every start) reads this repository’s public releases: once a release is published there, installed apps are offered it after the next start, and installing needs your confirmation. Please check that a problem still exists in the [latest release](https://github.com/unwritten-dev/VectaSim/releases/latest) before reporting it.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Report it privately through GitHub instead:

1. Open the repository’s [Security tab](https://github.com/unwritten-dev/VectaSim/security) and choose **Report a vulnerability** (direct link: [new private report](https://github.com/unwritten-dev/VectaSim/security/advisories/new)).
2. Describe what is affected, the VectaSim version, and the steps or a file that reproduces it. Leave personal data out of attachments: a diagnostics package always replaces your Windows user name in file paths and contains no passwords or keys; created with streamer mode on, it also hides registrations, callsigns and airlines and leaves out the raw dumps.

Only the maintainer sees the report and aims to answer within a week. Once a fix is released, the advisory is published, with credit if you want it.

## What is in scope

Anything that lets someone other than the user read or change data, run code or reach the PC through VectaSim, for example:

- the local overlay server (`docs/overlay-api.md`), in particular access from the LAN without the token,
- importing `.vectasim` backups or CSV logbooks,
- the auto-updater and its signature check, the `SimConnect.dll` download,
- data from online services (VATSIM, IVAO, METAR, SimBrief, Planespotters) shown in the app.

Bugs in the simulators themselves, in third-party add-ons or in the services VectaSim talks to are out of scope – please report those to their vendors.
