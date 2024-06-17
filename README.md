# Mayil Forge App

This forge app sends a post request to mayil servers and polls for the response. The response recieved is added as a comment to the issue.

## Requirements

See [Set up Forge](https://developer.atlassian.com/platform/forge/set-up-forge/) for instructions to get set up.

## Quick start
- Clone this repository
- Create a new Forge app by running `forge register` in the root directory of the cloned repository
- Set the app's name to `mayil-ai`
- Set Mayil server URL to custom endpoint say `mayil.yourdomain.com`

    - Add `mayil.yourdomain.com` to permissions.external.backend defined in `manifest.yml` to point to the Mayil server to be used

    - `forge variables set SERVER_URL 'mayil.yourdomain.com'` to point to the Mayil server to be used

- Build and deploy the app by running `forge deploy`

- Install the app in an Atlassian site by running `forge install`