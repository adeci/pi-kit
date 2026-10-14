self:
{ pkgs, ... }:
let
  package = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-kit-status;
in
{
  environment.systemPackages = [ package ];
  systemd.user.tmpfiles.rules = [
    "d %h/.agents/extensions - - - - -"
    "d %h/.pi/agent/extensions - - - - -"
    "L+ %h/.agents/extensions/kit-status - - - - ${package}/share/pi-kit/status/extension"
    "L+ %h/.pi/agent/extensions/kit-status - - - - ${package}/share/pi-kit/status/extension"
  ];
}
