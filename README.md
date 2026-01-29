# RS3 Quest Buddy Beta

[![GitHub](https://img.shields.io/badge/GitHub-Repository-blue)](https://github.com/Techpure2013/RS3QuestBuddyBeta)

A beta testing environment for RS3 Quest Buddy - a companion tool for RuneScape 3 quests.

## What is this Beta?

This beta version allows contributors to:
- Test new features before they go live
- Help with quest step data entry and validation
- Report bugs and suggest improvements
- Access the editor tools for quest content

## Prerequisites

- Node.js v18+
- npm
- Access to the database (requires SSH tunnel credentials from project maintainer)

## Setup Instructions

### 1. Clone the Repository

```bash
git clone https://github.com/Techpure2013/RS3QuestBuddyBeta.git
cd RS3QuestBuddyBeta
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment

Create a `.env` file with the required variables (get these from the project maintainer):

```env
DATABASE_URL=postgresql://...@localhost:5432/rs3questbuddy
# ... other variables provided by maintainer
RS3_SSH_HOST=<provided by maintainer>
```

### 4. Set Up Database Tunnel

Before running the server, you need to establish an SSH tunnel to the database:

```powershell
.\RS3DB.ps1
```

You'll be prompted for the SSH password. Keep this terminal window open.

### 4. Run the Server

In a new terminal:

```bash
npm run server
```

Server will start on `http://127.0.0.1:42069`

### 5. Run the Frontend (Development)

```bash
npm start
```

Frontend will be available at `http://127.0.0.1:3000`

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run server` | Start the API server |
| `npm start` | Start webpack dev server |
| `npm run build` | Build for production |

## For Contributors

1. Get SSH tunnel credentials from the project maintainer
2. Set up your `.env` file with provided values
3. Run the SSH tunnel before starting the server
4. Test features and report issues

## Troubleshooting

### Port Already in Use
If you get `EADDRINUSE` error, another process is using port 42069. Either:
- Stop the other process
- Or change `PORT` in `.env` to a different port

### Database Connection Failed
Make sure:
1. The SSH tunnel is running (`.\RS3DB.ps1`)
2. Your `RS3_SSH_HOST` is set correctly in `.env`
3. You have the correct database credentials

### Module Not Found
Run `npm install` to ensure all dependencies are installed.
