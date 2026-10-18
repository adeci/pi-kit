{ stdenvNoCC, bun }:
stdenvNoCC.mkDerivation {
  pname = "pi-kit-claude-billing";
  version = "0.1.0";
  src = ./.;
  dontBuild = true;
  nativeCheckInputs = [ bun ];
  doCheck = true;
  checkPhase = "bun test extension";
  installPhase = ''
    mkdir -p $out/share/pi-kit/claude-billing/extension
    cp extension/*.ts $out/share/pi-kit/claude-billing/extension/
    rm -f $out/share/pi-kit/claude-billing/extension/*.test.ts
    mkdir -p $out/share/pi-kit/claude-billing/tests
    cp tests/smoke.sh tests/verify.ts $out/share/pi-kit/claude-billing/tests/
    chmod +x $out/share/pi-kit/claude-billing/tests/smoke.sh
    cp package.json README.md NOTICE $out/share/pi-kit/claude-billing/
  '';
}
