cask "clance" do
  version "0.1.2"
  sha256 "efbcfbad213a48faa870ce895db4050cd5ba9b4119d37d9bef5faf585a12f995"

  url "https://github.com/damiensmith1/clance/releases/download/v#{version}/Clance-#{version}-arm64.zip"
  name "Clance"
  desc "Hotkey popup and on-device dictation for Claude Code"
  homepage "https://github.com/damiensmith1/clance"

  # Electron's own floor is macOS 13 (LSMinimumSystemVersion in the bundled
  # framework). whisper.cpp is the dictation engine: Clance resolves
  # whisper-cli from Homebrew's prefix rather than bundling it — see
  # docs/dictation.md, "Engine distribution".
  depends_on arch: :arm64
  depends_on formula: "whisper.cpp"
  depends_on macos: :ventura

  app "Clance.app"

  # Homebrew quarantines every cask download, and Clance isn't notarized
  # (notarization needs a paid Apple Developer membership). Left quarantined,
  # Gatekeeper blocks the first launch with "Apple could not verify Clance is
  # free of malware". Removing the attribute after install means Gatekeeper
  # never assesses it — the trust decision is installing from this tap at all.
  # Homebrew 7 requires declarative postflight_steps, and runs them in a
  # sandbox. {{appdir}} expands to the Applications directory the app was
  # installed into. writable_paths is required, not decorative: the sandbox
  # grants write access to appdir but *not* read access to anything under
  # the user's home folder, so with a home-relative appdir (a common
  # HOMEBREW_CASK_OPTS="--appdir=~/Applications" setup) xattr fails with
  # "Operation not permitted" and Homebrew rolls the whole install back.
  postflight_steps do
    run "/usr/bin/xattr",
        args:           ["-dr", "com.apple.quarantine", "{{appdir}}/Clance.app"],
        writable_paths: ["{{appdir}}/Clance.app"]
  end

  uninstall quit: "dev.damiensmith.clance"

  zap trash: [
    "~/.clance",
    "~/Library/Application Support/Clance",
    "~/Library/Application Support/clance",
    "~/Library/Preferences/dev.damiensmith.clance.plist",
    "~/Library/Saved Application State/dev.damiensmith.clance.savedState",
  ]

  caveats <<~EOS
    Clance runs the Claude Code CLI, which this cask doesn't install:
      https://code.claude.com/docs/en/setup

    On first launch Clance walks you through signing in and granting
    Accessibility, which it needs to type into other apps.
  EOS
end
