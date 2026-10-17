{
  lib,
  stdenvNoCC,
  python3,
  bun,
  git,
  ps,
  makeWrapper,
}:
stdenvNoCC.mkDerivation {
  pname = "pi-kit-agents";
  version = "0.2.0";
  src = ./.;
  nativeBuildInputs = [ makeWrapper ];
  nativeCheckInputs = [
    bun
    git
    python3
    ps
  ];
  dontBuild = true;
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    export HOME="$TMPDIR/home"
    mkdir -p "$HOME"
    mkdir -p ../ui ../shared
    cp ${../ui}/*.ts ../ui/
    cp ${../shared}/*.ts ../shared/
    bun test extension ../shared/completions.test.ts ../shared/completion-renderer.test.ts
    python3 -m unittest -v test_guard
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/pi-kit/agents/extension $out/share/pi-kit/agents/roles $out/share/skills/kit-agents
    mkdir -p $out/share/pi-kit/ui
    cp ${../ui}/*.ts $out/share/pi-kit/ui/
    mkdir -p $out/share/pi-kit/shared
    cp ${../shared}/completions.ts ${../shared}/completion-renderer.ts $out/share/pi-kit/shared/
    cp extension/*.ts $out/share/pi-kit/agents/extension/
    rm -f $out/share/pi-kit/agents/extension/*.test.ts
    cp roles/*.md $out/share/pi-kit/agents/roles/
    cp package.json guard.py README.md agents.example.json $out/share/pi-kit/agents/
    cp skill/SKILL.md $out/share/skills/kit-agents/
    makeWrapper ${python3}/bin/python3 $out/share/pi-kit/agents/guard \
      --add-flags $out/share/pi-kit/agents/guard.py \
      --prefix PATH : ${lib.makeBinPath [ ps ]}
    ln -s ${lib.getExe git} $out/share/pi-kit/agents/git
    runHook postInstall
  '';
  meta = {
    description = "Integrated parent-owned Pi subagents, reusable roles, isolated workspaces and inspector";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
}
