{
  lib,
  rustPlatform,
  pueue,
  bun,
}:
rustPlatform.buildRustPackage {
  pname = "pi-kit-jobs";
  version = "0.2.0";
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./Cargo.toml
      ./Cargo.lock
      ./src
      ./tests
      ./extension
      ./skill
      ./package.json
    ];
  };
  cargoLock.lockFile = ./Cargo.lock;
  nativeCheckInputs = [
    pueue
    bun
  ];
  postCheck = ''
    mkdir -p ../ui
    cp ${../ui}/*.ts ../ui/
    bun test extension
  '';
  postInstall = ''
    mkdir -p $out/share/pi-kit/jobs/extension $out/share/pi-kit/ui
    cp ${../ui}/*.ts $out/share/pi-kit/ui/
    cp extension/*.ts $out/share/pi-kit/jobs/extension/
    rm -f $out/share/pi-kit/jobs/extension/*.test.ts
    # Tests run from the source tree, so a module missing from the install
    # would only fail when Pi loads the extension. Resolve every relative
    # import against the installed files instead.
    for file in $out/share/pi-kit/jobs/extension/*.ts; do
      { grep -oE 'from "\.\.?/[^"]+"' "$file" || true; } | sed -E 's/^from "(.*)"$/\1/' | while read -r module; do
        target="$(dirname "$file")/$module"
        if [ ! -f "$target" ] && [ ! -f "$target.ts" ]; then
          echo "$file imports missing module $module" >&2
          exit 1
        fi
      done
    done
    cp package.json $out/share/pi-kit/jobs/
    mkdir -p $out/share/skills/kit-jobs
    cp skill/SKILL.md $out/share/skills/kit-jobs/
  '';
  meta = {
    description = "Pueue-backed background jobs with live Pi events";
    license = lib.licenses.mit;
    mainProgram = "pi-jobs";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
