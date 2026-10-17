self:
{
  lib,
  pkgs,
  config,
  ...
}:
let
  cfg = config.services.pi-jobs;
  cli = lib.getExe cfg.package;
  daemon =
    pkgs.writeShellScript "pi-jobs-pueue" # bash
      ''
        exec ${lib.getExe' pkgs.pueue "pueued"} --config "$(${cli} config-path)"
      '';
  # The callback readiness record expires whenever the daemon socket changes,
  # so verify it after every daemon start instead of leaving `doctor` to users.
  verify =
    pkgs.writeShellScript "pi-jobs-verify" # bash
      ''
        for _ in 1 2 3 4 5 6 7 8 9 10; do
          ${cli} doctor && exit 0
          sleep 1
        done
        exec ${cli} doctor
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
    systemd.user.tmpfiles.rules = [
      "d %h/.agents/skills - - - - -"
      "d %h/.agents/extensions - - - - -"
      "L+ %h/.agents/skills/kit-jobs - - - - ${cfg.package}/share/skills/kit-jobs"
      "L+ %h/.agents/extensions/kit-jobs - - - - ${cfg.package}/share/pi-kit/jobs/extension"
      "d %h/.pi/agent/extensions - - - - -"
      "L+ %h/.pi/agent/extensions/kit-jobs - - - - ${cfg.package}/share/pi-kit/jobs/extension"
    ];
    systemd.user.services.pi-jobs-pueue = lib.mkIf cfg.enable {
      description = "Isolated Pueue daemon for Pi jobs";
      wantedBy = [ "default.target" ];
      unitConfig.ConditionUser = "!root";
      path = [
        cfg.package
        "/run/current-system/sw"
        pkgs.bash
        pkgs.coreutils
      ];
      serviceConfig = {
        # $XDG_RUNTIME_DIR is tmpfs; recreate the daemon's directory on every
        # start. `pi-jobs init` also repairs it for custom configs.
        RuntimeDirectory = "pi-jobs/pueue";
        RuntimeDirectoryMode = "0700";
        ExecStartPre = "${cli} init --callbacks --shell bash";
        ExecStart = daemon;
        Restart = "on-failure";
        RestartSec = "2s";
        TimeoutStartSec = "15s";
        TimeoutStopSec = "10s";
        UMask = "0077";
      };
    };
    # A separate unit keeps the daemon's own start (and Pueue's scheduling)
    # independent of verification: a failed check leaves the daemon running and
    # the jobs extension reports it as not ready.
    systemd.user.services.pi-jobs-doctor = lib.mkIf cfg.enable {
      description = "Verify the Pi jobs completion callback after Pueue starts";
      wantedBy = [ "pi-jobs-pueue.service" ];
      after = [ "pi-jobs-pueue.service" ];
      bindsTo = [ "pi-jobs-pueue.service" ];
      unitConfig.ConditionUser = "!root";
      serviceConfig = {
        Type = "oneshot";
        ExecStart = verify;
        TimeoutStartSec = "90s";
        UMask = "0077";
      };
    };
  };
}
