# ChatGPT Project Exporter

A lightweight Chrome extension for exporting all conversations in a ChatGPT Project to a ZIP package (`Markdown + JSON`).

## Install

This extension is not on Chrome Web Store yet. Install it via **Load unpacked**:

1. Download the latest source `.zip` from **Releases**.
2. Open `chrome://extensions/`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the `chrome_extension` folder.

## Usage

1. Sign in to ChatGPT and open the target `Project`.
2. Click the **ChatGPT Exporter** icon in the browser toolbar.
3. Confirm the detected project name in the popup.
4. Optional: set a date range (leave empty to export all loaded history in the current view).
5. Click **Start Export**.
6. Wait for collection to finish, then download the generated `.zip` file.
