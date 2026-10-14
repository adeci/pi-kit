{ stdenvNoCC, bun }:
stdenvNoCC.mkDerivation {
  pname = "pi-kit-handoff";
  version = "0.2.0";
  src = ./.;
  dontBuild = true;
  nativeCheckInputs = [ bun ];
  doCheck = true;
  checkPhase = ''
    bun test extension
  '';
  installPhase = ''
    mkdir -p $out/share/pi-kit/handoff/extension $out/share/pi-kit/ui
    cp extension/*.ts $out/share/pi-kit/handoff/extension/
    rm -f $out/share/pi-kit/handoff/extension/*.test.ts
    cp ${../ui}/*.ts $out/share/pi-kit/ui/
    cp package.json README.md $out/share/pi-kit/handoff/
  '';
}
