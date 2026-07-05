# Desktop Novel

This is a desktop application built with [Tauri v2](https://v2.tauri.app/), [React](https://reactjs.org/), [TypeScript](https://www.typescriptlang.org/), and [Vite](https://vitejs.dev/).

## Prerequisites

- [Node.js](https://nodejs.org/)
- [Rust](https://www.rust-lang.org/) and the required Tauri prerequisites (see [Tauri documentation](https://v2.tauri.app/start/prerequisites/)).

## How to run the project

1. **Install dependencies**:
   Run the following command in the project directory:
   ```bash
   npm install
   ```

2. **Run the development server**:
   To start the app in development mode (which will start Vite and the Tauri window):
   ```bash
   npm run tauri dev
   ```

## Build for production

To build the application for release:
```bash
npm run tauri build
```
