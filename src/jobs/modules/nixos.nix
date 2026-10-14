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
        ExecStartPre = "${cli} init --callbacks --shell bash";
        ExecStart = daemon;
        Restart = "on-failure";
        RestartSec = "2s";
        TimeoutStartSec = "15s";
        TimeoutStopSec = "10s";
        UMask = "0077";
      };
    };
  };
}
