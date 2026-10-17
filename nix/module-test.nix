{
  inputs,
  self,
  pkgs,
  system,
}:
let
  inherit (pkgs) lib;
  components = [
    "agents"
    "ask"
    "director"
    "events"
    "goal"
    "handoff"
    "jobs"
    "status"
    "todos"
    "usage"
  ];
  package = name: self.packages.${system}."pi-kit-${name}";
  evaluate =
    selected: daemon:
    (inputs.nixpkgs.lib.nixosSystem {
      inherit system;
      modules = [
        self.nixosModules.default
        {
          pi-kit = lib.genAttrs selected (_: {
            enable = true;
          });
        }
        {
          system.stateVersion = "26.05";
          pi-kit.jobs.daemon.enable = daemon;
        }
      ];
    }).config;
  enabled = evaluate components true;
  noDaemon = evaluate components false;
  off = evaluate [ ] false;
  service = enabled.systemd.user.services.pi-jobs-pueue;
  doctor = enabled.systemd.user.services.pi-jobs-doctor;
  moduleNames = builtins.sort builtins.lessThan ([ "default" ] ++ components);
in
assert builtins.attrNames self.nixosModules == moduleNames;
assert builtins.attrNames self.darwinModules == moduleNames;
assert
  builtins.attrNames self.packages.${system} == builtins.sort builtins.lessThan (
    [
      "default"
      "pi-kit"
      "skills"
    ]
    ++ map (name: "pi-kit-${name}") components
  );
assert builtins.attrNames off.pi-kit == components;
assert builtins.all (
  name:
  builtins.elem (package name) enabled.environment.systemPackages
  && !(builtins.elem (package name) off.environment.systemPackages)
  && builtins.elem "L+ %h/.pi/agent/extensions/kit-${name} - - - - ${package name}/share/pi-kit/${name}/extension" enabled.systemd.user.tmpfiles.rules
) components;
# Every component except Director works alone; Director requires Agents.
assert builtins.all (
  name:
  let
    cfg = evaluate [ name ] false;
  in
  builtins.elem (package name) cfg.environment.systemPackages
  && !(cfg.systemd.user.services ? pi-jobs-pueue)
  && builtins.all (
    other: name == other || !(builtins.elem (package other) cfg.environment.systemPackages)
  ) components
) (builtins.filter (name: name != "director") components);
assert !(off.systemd.user.services ? pi-jobs-pueue);
assert !(noDaemon.systemd.user.services ? pi-jobs-pueue);
assert builtins.elem (package "jobs") noDaemon.environment.systemPackages;
assert !(enabled.systemd.services ? pi-jobs-pueue);
assert service.wantedBy == [ "default.target" ];
assert service.unitConfig.ConditionUser == "!root";
assert service.serviceConfig.UMask == "0077";
# The runtime directory is tmpfs and must be recreated on every start.
assert service.serviceConfig.RuntimeDirectory == "pi-jobs/pueue";
assert service.serviceConfig.RuntimeDirectoryMode == "0700";
# Starting the service must not override Pueue's scheduling policy.
assert !(service.serviceConfig ? ExecStartPost);
# Every daemon start re-verifies the callback in a separate unit, so a failed
# check never fails the daemon itself.
assert doctor.wantedBy == [ "pi-jobs-pueue.service" ];
assert doctor.bindsTo == [ "pi-jobs-pueue.service" ];
assert doctor.after == [ "pi-jobs-pueue.service" ];
assert doctor.serviceConfig.Type == "oneshot";
assert !(noDaemon.systemd.user.services ? pi-jobs-doctor);
pkgs.runCommand "pi-kit-module-check" { } ''
  export HOME="$TMPDIR/home"
  for directory in .agents/extensions .pi/agent/extensions; do
    mkdir -p "$HOME/$directory"
    for name in ${lib.concatStringsSep " " components}; do
      ln -s /nix/store/fixture/share/pi-kit/$name/extension "$HOME/$directory/kit-$name"
    done
  done
  for directory in .agents/skills .pi/agent/skills; do
    mkdir -p "$HOME/$directory"
    for name in agents jobs; do
      ln -s /nix/store/fixture/share/skills/kit-$name "$HOME/$directory/kit-$name"
    done
  done
  # Managed names do not grant ownership of unrelated links or regular files.
  rm "$HOME/.pi/agent/extensions/kit-events" "$HOME/.pi/agent/extensions/kit-jobs"
  ln -s /custom/extension "$HOME/.pi/agent/extensions/kit-events"
  echo user-file > "$HOME/.pi/agent/extensions/kit-jobs"
  ${off.systemd.user.services.pi-kit-links.serviceConfig.ExecStart}
  for directory in .agents/extensions .pi/agent/extensions; do
    for name in ${lib.concatStringsSep " " components}; do
      if [ "$directory" = .pi/agent/extensions ] && { [ "$name" = events ] || [ "$name" = jobs ]; }; then continue; fi
      test ! -L "$HOME/$directory/kit-$name"
    done
  done
  for directory in .agents/skills .pi/agent/skills; do
    for name in agents jobs; do
      test ! -L "$HOME/$directory/kit-$name"
    done
  done
  test -L "$HOME/.pi/agent/extensions/kit-events"
  test -f "$HOME/.pi/agent/extensions/kit-jobs"
  touch $out
''
