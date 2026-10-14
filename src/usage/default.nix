{ stdenvNoCC, bun }:
stdenvNoCC.mkDerivation {
  pname = "pi-kit-usage";
  version = "0.1.0";
  src = ./.;
  dontBuild = true;
  nativeCheckInputs = [ bun ];
  doCheck = true;
  checkPhase = "bun test extension";
  installPhase = ''
    mkdir -p $out/share/pi-kit/usage/extension
    cp extension/*.ts $out/share/pi-kit/usage/extension/
    rm -f $out/share/pi-kit/usage/extension/*.test.ts
    cp package.json README.md NOTICE $out/share/pi-kit/usage/
  '';
}
