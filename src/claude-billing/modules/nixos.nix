self:
{ pkgs, ... }:
let
  package = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-kit-claude-billing;
in
{
  environment.systemPackages = [ package ];
  systemd.user.tmpfiles.rules = [
    "d %h/.agents/extensions - - - - -"
    "d %h/.pi/agent/extensions - - - - -"
    "L+ %h/.agents/extensions/kit-claude-billing - - - - ${package}/share/pi-kit/claude-billing/extension"
    "L+ %h/.pi/agent/extensions/kit-claude-billing - - - - ${package}/share/pi-kit/claude-billing/extension"
  ];
}
