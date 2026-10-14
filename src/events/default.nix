{
  lib,
  stdenvNoCC,
  python3,
  bun,
  makeWrapper,
}:
stdenvNoCC.mkDerivation {
  pname = "pi-kit-events";
  version = "0.2.0";
  src = ./.;
  nativeBuildInputs = [ makeWrapper ];
  nativeCheckInputs = [
    python3
    bun
  ];
  dontBuild = true;
  postPatch = ''
    substituteInPlace names.py \
      --replace-fail '#!/usr/bin/env python3' '#!${python3}/bin/python3'
  '';
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    python3 -m unittest -v test_events test_protocol test_names
    mkdir -p ../shared
    cp ${../shared}/*.ts ../shared/
    bun test extension
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin $out/libexec $out/share/pi-kit/events/extension
    cp events.py $out/libexec/pi-events.py
    cp names.py $out/libexec/names.py
    cp names.py $out/share/pi-kit/events/names.py
    chmod +x $out/share/pi-kit/events/names.py
    makeWrapper ${python3}/bin/python3 $out/bin/pi-events --add-flags $out/libexec/pi-events.py
    cp extension/*.ts $out/share/pi-kit/events/extension/
    rm -f $out/share/pi-kit/events/extension/*.test.ts
    mkdir -p $out/share/pi-kit/shared
    cp ${../shared}/completions.ts ${../shared}/completion-renderer.ts $out/share/pi-kit/shared/
    cp package.json $out/share/pi-kit/events/
    runHook postInstall
  '';
  meta = {
    description = "Live local publish/subscribe events for Pi and other tools";
    license = lib.licenses.mit;
    mainProgram = "pi-events";
    platforms = lib.platforms.unix;
  };
}
