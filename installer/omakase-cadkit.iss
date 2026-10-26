; Windows installer for the download bundle. `npm run bundle` on Windows compiles it with
; Inno Setup 6 (ISCC), passing:
;   /DAppVersion=0.1.0-alpha.1 /DNumericVersion=0.1.0 /DSourceDir=<staged bundle>
;   /DOutputDir=<dist-bundle> /DOutputName=<file name without .exe>
; Per-user install: no administrator rights, nothing outside the user's profile. It adds a
; Start menu entry, "Open with" for .dwg/.dxf, and an uninstaller in Installed apps.

#ifndef AppVersion
  #error Pass /DAppVersion=...
#endif

[Setup]
AppId={{1E11F611-F10E-4347-B98D-3F7B2BE94708}
AppName=omakase-cadkit
AppVersion={#AppVersion}
AppVerName=omakase-cadkit {#AppVersion}
VersionInfoVersion={#NumericVersion}
AppPublisher=omakase-cadkit contributors
AppPublisherURL=https://github.com/itama8/omakase-cadkit
AppSupportURL=https://github.com/itama8/omakase-cadkit/issues
DefaultDirName={autopf}\omakase-cadkit
DefaultGroupName=omakase-cadkit
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename={#OutputName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=omakase-cadkit
UninstallDisplayIcon={app}\omakase-cadkit.exe
SetupIconFile=..\assets\omakase-cadkit.ico
ChangesAssociations=yes
; The viewer server and sidecar run from {app}; close them before replacing their files.
CloseApplications=force
CloseApplicationsFilter=*.exe

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[InstallDelete]
; Compiled code from an older version must not linger next to the new files.
Type: filesandordirs; Name: "{app}\dist"
Type: filesandordirs; Name: "{app}\viewer\dist"
Type: filesandordirs; Name: "{app}\bin\sidecar"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\omakase-cadkit"; Filename: "{app}\omakase-cadkit.exe"; Comment: "View, inspect and lint DWG/DXF drawings"
Name: "{autodesktop}\omakase-cadkit"; Filename: "{app}\omakase-cadkit.exe"; Tasks: desktopicon

[Registry]
; Offer the viewer under "Open with" for drawings without taking over AutoCAD's default.
Root: HKA; Subkey: "Software\Classes\omakase-cadkit.drawing"; ValueType: string; ValueName: ""; ValueData: "Drawing (omakase-cadkit)"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\omakase-cadkit.drawing\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: """{app}\omakase-cadkit.exe"",0"
Root: HKA; Subkey: "Software\Classes\omakase-cadkit.drawing\shell\open"; ValueType: string; ValueName: "FriendlyAppName"; ValueData: "omakase-cadkit"
Root: HKA; Subkey: "Software\Classes\omakase-cadkit.drawing\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\omakase-cadkit.exe"" view ""%1"""
Root: HKA; Subkey: "Software\Classes\.dwg\OpenWithProgids"; ValueType: string; ValueName: "omakase-cadkit.drawing"; ValueData: ""; Flags: uninsdeletevalue
Root: HKA; Subkey: "Software\Classes\.dxf\OpenWithProgids"; ValueType: string; ValueName: "omakase-cadkit.drawing"; ValueData: ""; Flags: uninsdeletevalue

[Run]
Filename: "{app}\omakase-cadkit.exe"; Description: "{cm:LaunchProgram,omakase-cadkit}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{app}\omakase-cadkit.exe"; Parameters: "stop"; Flags: runhidden waituntilterminated; RunOnceId: "StopViewer"

[Code]
// An upgrade replaces files a running viewer holds open: stop it first.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  Exe: String;
begin
  Exe := ExpandConstant('{app}\omakase-cadkit.exe');
  if FileExists(Exe) then
    Exec(Exe, 'stop', ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;
