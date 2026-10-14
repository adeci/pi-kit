{ stdenvNoCC, bun }:
stdenvNoCC.mkDerivation {
  pname = "pi-kit-todos";
  version = "0.1.0";
  src = ./.;
  dontBuild = true;
  nativeCheckInputs = [ bun ];
  doCheck = true;
  checkPhase = ''
    bun test extension/state.test.ts
  '';
  installPhase = ''
    mkdir -p $out/share/pi-kit/todos/extension $out/share/pi-kit/ui
    cp extension/*.ts $out/share/pi-kit/todos/extension/
    rm -f $out/share/pi-kit/todos/extension/*.test.ts
    cp ${../ui}/*.ts $out/share/pi-kit/ui/
    cp package.json README.md $out/share/pi-kit/todos/
  '';
}
