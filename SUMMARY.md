# Project Summary

## Language
- **Type:** Go
- **Files:** Located in the `backend/` and `desktop/` directories.

## Folder Structure
- **backend/**: Contains backend scripts and logic.
  - **Files & Subdirectories:**
    ```plaintext
    backend/
    ├── search.go
    ├── models.go
    ├── Dockerfile
    └── other_backend_files.go
    ```
- **searxng/**: Contains SearxNG configuration and possibly other related files.
  - **Files & Subdirectories:**
    ```plaintext
    searxng/
    ├── settings.yml
    └── other_searx_files.py
    ```
- **desktop/**: Contains desktop application related files.
  - **Files & Subdirectories:**
    ```plaintext
    desktop/
    ├── README.md
    └── other_desktop_files.go
    ```
- **scripts/**: Contains various scripts.
  - **Files & Subdirectories:**
    ```plaintext
    scripts/
    ├── deploy.sh
    ├── pull-models.sh
    ├── smoke-test.sh
    └── other_scripts.sh
    ```
- **ai/**: Contains AI-specific code and tasks.
  - **Files & Subdirectories:**
    ```plaintext
    ai/
    ├── tasks.md
    └── other_ai_files.py
    ```
- **docker-compose.yml**: Docker configuration file.
- **Caddyfile**: Configuration file for the Caddy server.
- **README.md**: Project documentation.

## Key Files
- **README.md**: Located at the root, contains project documentation.
- **docker-compose.yml**: Located at the root, contains Docker configuration.
- **Caddyfile**: Located at the root, contains Caddy server configuration.

## Summary
This project is a Go-based application with a frontend (`www/`) and backend (`backend/`). It also includes directories for SearxNG (`searxng/`), a desktop application (`desktop/`), scripts (`scripts/`), and AI tasks (`ai/`). The project uses Docker and Caddy, indicating a containerized deployment environment.

