@echo off
REM Supplies the ADO PAT to git over stdout when git asks for credentials.
REM
REM Git invokes GIT_ASKPASS with the prompt text as %1 and reads the answer
REM from stdout. The secret arrives through the GIT_PAT environment variable,
REM which - unlike a command-line argument or a remote URL written into
REM .git/config - is not visible to other processes and is never persisted.
REM
REM The username is carried in the remote URL (any non-empty value works for
REM Azure DevOps PAT auth), so only the password prompt reaches this script.
echo %GIT_PAT%
