
# Slayr Protect

A dark-themed Luau obfuscator and script dashboard.

## Features

- User registration and login
- Scope-aware renaming of local variables, functions, parameters, and loop variables to randomized alphabetic identifiers
- Optional randomized byte-stream encoding for strings, numbers, and property names, with encoded-payload integrity checks, in the Strong profile
- Upload `.lua` and `.luau` files
- Dashboard with recent jobs and statistics
- Password hashing
- SQLite database

## Requirements

- Node.js 20+
- npm

## Local setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env`.

3. Set a secure `SESSION_SECRET` in your `.env` file.

4. Start the application:

   ```bash
   npm start
   ```

5. Open `http://localhost:3000`.

## Railway deployment

1. Upload the project files to GitHub.
2. Connect the repository to Railway.
3. Set the `SESSION_SECRET` variable in Railway.
4. Deploy the service.
5. Generate a public domain in Railway's Networking settings.
6. Check `/health` to verify the server is running.

## Obfuscation profiles

- **Standard** parses Luau and renames local bindings using scope analysis. Global names, table properties, type names, and implicit `self` are preserved.
- **Strong** also applies per-payload randomized byte-stream encoding to ordinary string and finite numeric literals, table keys, property names, and eligible method names throughout the parsed syntax tree, then reconstructs values at runtime. This includes values in local declarations, return expressions, branches, and nested functions. A runtime checksum detects edits to encoded payloads; it does not make the full script tamper-proof.

Obfuscation is not encryption and cannot prevent determined reverse engineering. Strong mode adds runtime work. Test output in the Luau environment where it will run. Sources over 1 MB and syntax or string escapes that the parser cannot safely handle are rejected.

## License

Personal use.
