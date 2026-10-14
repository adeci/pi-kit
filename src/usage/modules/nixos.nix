self:
{ pkgs, ... }:
let
  package = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-kit-usage;
in
{
  environment.systemPackages = [ package ];
  systemd.user.tmpfiles.rules = [
    "d %h/.agents/extensions - - - - -"
    "d %h/.pi/agent/extensions - - - - -"
    "L+ %h/.agents/extensions/kit-usage - - - - ${package}/share/pi-kit/usage/extension"
    "L+ %h/.pi/agent/extensions/kit-usage - - - - ${package}/share/pi-kit/usage/extension"
  ];
}
