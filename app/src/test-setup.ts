// Vitest setup: tests must not depend on the machine's locale. GitHub's runners report
// navigator.language = "en-US", developer machines may report "de-DE"; pin it so the default
// UI language ("system") resolves the same everywhere. Tests that check German texts pin
// German explicitly with setLanguageSetting("de") or <I18nProvider lang="de">.
Object.defineProperty(globalThis.navigator, "language", { value: "en-US", configurable: true });
Object.defineProperty(globalThis.navigator, "languages", { value: ["en-US"], configurable: true });
