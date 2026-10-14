{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    flake-parts.inputs.nixpkgs-lib.follows = "nixpkgs";
    treefmt-nix.url = "github:numtide/treefmt-nix";
    treefmt-nix.inputs.nixpkgs.follows = "nixpkgs";
  };
  outputs =
    inputs@{ flake-parts, self, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [ inputs.treefmt-nix.flakeModule ];
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      flake.nixosModules = {
        default = import ./nix/suite.nix self "nixos";
        status = import ./src/status/modules/nixos.nix self;
        usage = import ./src/usage/modules/nixos.nix self;
        ask = import ./src/ask/modules/nixos.nix self;
        goal = import ./src/goal/modules/nixos.nix self;
        director = import ./src/director/modules/nixos.nix self;
        handoff = import ./src/handoff/modules/nixos.nix self;
        todos = import ./src/todos/modules/nixos.nix self;
        agents = import ./src/agents/modules/nixos.nix self;
        jobs = import ./src/jobs/modules/nixos.nix self;
        events = import ./src/events/modules/nixos.nix self;
      };
      flake.darwinModules = {
        default = import ./nix/suite.nix self "darwin";
        status = import ./src/status/modules/darwin.nix self;
        usage = import ./src/usage/modules/darwin.nix self;
        ask = import ./src/ask/modules/darwin.nix self;
        goal = import ./src/goal/modules/darwin.nix self;
        director = import ./src/director/modules/darwin.nix self;
        handoff = import ./src/handoff/modules/darwin.nix self;
        todos = import ./src/todos/modules/darwin.nix self;
        agents = import ./src/agents/modules/darwin.nix self;
        jobs = import ./src/jobs/modules/darwin.nix self;
        events = import ./src/events/modules/darwin.nix self;
      };
      perSystem =
        {
          pkgs,
          config,
          system,
          ...
        }:
        {
          packages = {
            pi-kit-status = pkgs.callPackage ./src/status/default.nix { };
            pi-kit-usage = pkgs.callPackage ./src/usage/default.nix { };
            pi-kit-ask = pkgs.callPackage ./src/ask/default.nix { };
            pi-kit-goal = pkgs.callPackage ./src/goal/default.nix { };
            pi-kit-director = pkgs.callPackage ./src/director/default.nix { };
            pi-kit-handoff = pkgs.callPackage ./src/handoff/default.nix { };
            pi-kit-todos = pkgs.callPackage ./src/todos/default.nix { };
            pi-kit-agents = pkgs.callPackage ./src/agents/default.nix { };
            pi-kit-jobs = pkgs.callPackage ./src/jobs/default.nix { };
            pi-kit-events = pkgs.callPackage ./src/events/default.nix { };
            skills = pkgs.runCommand "pi-kit-skills" { } ''
              mkdir -p $out/share/skills/kit-agents $out/share/skills/kit-jobs
              cp ${./src/agents/skill/SKILL.md} $out/share/skills/kit-agents/
              cp ${./src/jobs/skill/SKILL.md} $out/share/skills/kit-jobs/
            '';
            pi-kit = pkgs.symlinkJoin {
              name = "pi-kit";
              paths = [
                config.packages.pi-kit-status
                config.packages.pi-kit-usage
                config.packages.pi-kit-ask
                config.packages.pi-kit-goal
                config.packages.pi-kit-director
                config.packages.pi-kit-handoff
                config.packages.pi-kit-todos
                config.packages.pi-kit-agents
                config.packages.pi-kit-events
                config.packages.skills
                config.packages.pi-kit-jobs
              ];
            };
            default = config.packages.pi-kit;
          };
          devShells.default = pkgs.mkShell {
            packages = with pkgs; [
              cargo
              rustc
              clippy
              rustfmt
              rust-analyzer
              pueue
              git
              bun
              python3
            ];
          };
          treefmt = {
            projectRootFile = "flake.nix";
            programs = {
              nixfmt.enable = true;
              rustfmt.enable = true;
              prettier.enable = true;
              deadnix.enable = true;
              statix.enable = true;
              ruff-check.enable = true;
              ruff-format.enable = true;
            };
            settings.global.excludes = [ "**/Cargo.lock" ];
          };
          checks = {
            status = config.packages.pi-kit-status;
            usage = config.packages.pi-kit-usage;
            ask = config.packages.pi-kit-ask;
            goal = config.packages.pi-kit-goal;
            director = config.packages.pi-kit-director;
            handoff = config.packages.pi-kit-handoff;
            todos = config.packages.pi-kit-todos;
            agents = config.packages.pi-kit-agents;
            jobs = config.packages.pi-kit-jobs;
            events = config.packages.pi-kit-events;
          }
          // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
            module = import ./nix/module-test.nix {
              inherit
                inputs
                self
                pkgs
                system
                ;
            };
          };
        };
    };
}
