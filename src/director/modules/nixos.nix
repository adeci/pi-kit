self:
{ pkgs, ... }:
let
  package = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-kit-director;
in
{
  environment.systemPackages = [ package ];
  systemd.user.tmpfiles.rules = [
    "d %h/.agents/extensions - - - - -"
    "d %h/.pi/agent/extensions - - - - -"
    "L+ %h/.agents/extensions/kit-director - - - - ${package}/share/pi-kit/director/extension"
    "L+ %h/.pi/agent/extensions/kit-director - - - - ${package}/share/pi-kit/director/extension"
  ];
}
