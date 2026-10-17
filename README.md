
# Slayr Protect

A dark-themed Luau code minifier and script dashboard.

## Features

- User registration and login
- Luau code minification
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

## Important

Slayr Protect currently performs basic Luau minification. It does not provide strong encryption or guarantee that code cannot be reverse-engineered.

## License

Personal use.
