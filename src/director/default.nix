{ stdenvNoCC, bun }:
stdenvNoCC.mkDerivation {
  pname = "pi-kit-director";
  version = "0.1.0";
  src = ./.;
  dontBuild = true;
  nativeCheckInputs = [ bun ];
  doCheck = true;
  checkPhase = ''
    bun test extension
  '';
  installPhase = ''
    mkdir -p $out/share/pi-kit/director/extension $out/share/pi-kit/ui
    cp extension/*.ts $out/share/pi-kit/director/extension/
    rm -f $out/share/pi-kit/director/extension/*.test.ts
    cp ${../ui}/*.ts $out/share/pi-kit/ui/
    cp package.json README.md OMP-LICENSE $out/share/pi-kit/director/
  '';
}
