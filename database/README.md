# Local MySQL setup

Run the schema from the repository root.

Windows PowerShell:

    Get-Content .\database\schema.sql |
      & 'C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe' -u root -p

Set these values in the root .env file:

    DB_HOST=127.0.0.1
    DB_PORT=3306
    DB_NAME=milon_ameria
    DB_USER=root
    DB_PASSWORD=your-local-password
    DB_CONNECTION_LIMIT=10
    ADMIN_ACCESS_TOKEN=choose-a-local-admin-token

The regular dashboard remains at /. The separate admin page is available at:

    http://localhost:5173/#admin

The admin API is protected by the x-admin-token header and reads from audit_events and user_sessions.