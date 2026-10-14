{ stdenvNoCC, bun }:
stdenvNoCC.mkDerivation {
  pname = "pi-kit-status";
  version = "0.1.0";
  src = ./.;
  dontBuild = true;
  nativeCheckInputs = [ bun ];
  doCheck = true;
  checkPhase = "bun test extension";
  installPhase = ''
    mkdir -p $out/share/pi-kit/status/extension
    cp extension/*.ts $out/share/pi-kit/status/extension/
    rm -f $out/share/pi-kit/status/extension/*.test.ts
    cp package.json README.md NOTICE $out/share/pi-kit/status/
  '';
}
