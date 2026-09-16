# PCB23D for agents — render a KiCad board to 3D PNGs

You are rendering a KiCad PCB to PNG images (top, bottom, angled 3D). Use the `pcb23d`
single-binary CLI. It has no dependencies and runs offline.

## 1. Download the binary for this machine

Releases: https://github.com/TensorFleet/pcb23d/releases/latest
Asset names: pcb23d-linux-x64, pcb23d-linux-arm64, pcb23d-darwin-x64, pcb23d-darwin-arm64, pcb23d-windows-x64.exe

Linux/macOS:

    os=$(uname -s | tr '[:upper:]' '[:lower:]')          # linux | darwin
    arch=$(uname -m); case "$arch" in x86_64) arch=x64;; aarch64|arm64) arch=arm64;; esac
    curl -fsSL -o pcb23d "https://github.com/TensorFleet/pcb23d/releases/latest/download/pcb23d-${os}-${arch}"
    chmod +x pcb23d
    ./pcb23d --version

Windows (PowerShell):

    Invoke-WebRequest https://github.com/TensorFleet/pcb23d/releases/latest/download/pcb23d-windows-x64.exe -OutFile pcb23d.exe
    .\pcb23d.exe --version

Alternative without a binary (needs Bun or Node 18+): `bunx pcb23d --help` or `npx pcb23d --help`
are not available; instead `bun add pcb23d` and call `renderPcb()` from TypeScript.

## 2. Pass in the KiCad project

Input is either a `.kicad_pcb` file or a `.zip` of the whole KiCad project. Zips are searched
for the board; the `.kicad_pro`'s sibling `.kicad_pcb` wins, backups are ignored.

    ./pcb23d path/to/project.zip --out renders --json
    ./pcb23d path/to/board.kicad_pcb --out renders --views top,bottom,angle
    ./pcb23d https://github.com/owner/repo --out renders --json      # public GitHub repo, tree URL, or owner/repo

Outputs land in `--out` as `<input-stem>-<view>.png` (transparent background by default).
`--json` prints a summary to stdout: board size in mm, layer count, footprint/track/via counts,
and the path of every PNG written. Exit code 0 on success, 1 if any input failed, 2 for bad flags.

## 3. Useful options

    --views top,bottom,angle,angle-bottom,front,side   # or: all
    --views hero=45/30 --views low=20/12/ortho          # custom azimuth/elevation[/persp|ortho]
    --width 1600 --height 1200 --supersample 2          # image size, anti-aliasing 1-4
    --bg "#ffffff"                                      # or transparent (default)
    --mask black --finish silver --silk white           # override board colours
    --no-components                                     # bare board, no body boxes

Limits to tell the user about: footprint 3D models are not drawn (components are boxes sized
from fab outlines); only the outer copper layers are visible. GitHub inputs use the anonymous
API (60 requests/hour) unless GITHUB_TOKEN is set.
