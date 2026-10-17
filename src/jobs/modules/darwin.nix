self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.pi-jobs;
  user = config.system.primaryUser;
  home = config.users.users.${user}.home;
  cli = lib.getExe cfg.package;
  daemon =
    pkgs.writeShellScript "pi-jobs-pueue" # bash
      ''
        mkdir -p "$XDG_RUNTIME_DIR"
        chmod 700 "$XDG_RUNTIME_DIR"
        ${cli} init --callbacks --shell bash
        # The callback readiness record expires whenever the daemon socket
        # changes; verify it once the new daemon is listening.
        (
          for _ in 1 2 3 4 5 6 7 8 9 10; do
            sleep 1
            ${cli} doctor >/dev/null 2>&1 && exit 0
          done
        ) &
        exec ${lib.getExe' pkgs.pueue "pueued"} --config "$(${cli} config-path)"
      '';
in
{
  options.services.pi-jobs = {
    enable = lib.mkEnableOption "isolated Pueue jobs for Pi";
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-kit-jobs;
      description = "pi-jobs CLI and bundled Pi extension package";
    };
  };
  config = {
    environment.systemPackages = [ cfg.package ];
    environment.variables.XDG_RUNTIME_DIR = lib.mkDefault "/tmp/pi-kit-${user}";
    launchd.user.agents.pi-jobs-pueue = lib.mkIf cfg.enable {
      serviceConfig = {
        Label = "org.pi-kit.pi-jobs-pueue";
        ProgramArguments = [ "${daemon}" ];
        EnvironmentVariables = {
          HOME = home;
          XDG_RUNTIME_DIR = config.environment.variables.XDG_RUNTIME_DIR;
          PATH =
            (lib.makeBinPath [
              cfg.package
              pkgs.coreutils
              pkgs.bash
            ])
            + ":/run/current-system/sw/bin";
        };
        RunAtLoad = true;
        KeepAlive.SuccessfulExit = false;
        ProcessType = "Background";
        Umask = 63;
      };
    };
    system.activationScripts.postActivation.text = # bash
      ''
        install -d -m 700 -o ${user} -g staff ${config.environment.variables.XDG_RUNTIME_DIR}
        install -d -o ${user} -g staff ${home}/.agents/skills ${home}/.agents/extensions
        ln -sfn ${cfg.package}/share/skills/kit-jobs ${home}/.agents/skills/kit-jobs
        ln -sfn ${cfg.package}/share/pi-kit/jobs/extension ${home}/.agents/extensions/kit-jobs
        install -d -o ${user} -g staff ${home}/.pi/agent/extensions
        ln -sfn ${cfg.package}/share/pi-kit/jobs/extension ${home}/.pi/agent/extensions/kit-jobs
      '';
  };
}
