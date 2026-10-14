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
  postCheck = "bun test extension";
  postInstall = ''
    mkdir -p $out/share/pi-kit/jobs/extension $out/share/pi-kit/ui
    cp ${../ui}/*.ts $out/share/pi-kit/ui/
    cp extension/index.ts extension/watcher.ts $out/share/pi-kit/jobs/extension/
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
