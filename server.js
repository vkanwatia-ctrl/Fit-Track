// Complete Strava OAuth2 backend code

const express = require('express');
const request = require('request');
const querystring = require('querystring');

const app = express();
const PORT = process.env.PORT || 3000;

const STRAVA_CLIENT_ID = 'your_client_id';
const STRAVA_CLIENT_SECRET = 'your_client_secret';
const STRAVA_REDIRECT_URI = 'your_redirect_uri';

app.get('/auth/strava', (req, res) => {
    const redirect_uri = querystring.escape(STRAVA_REDIRECT_URI);
    res.redirect(`https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&redirect_uri=${redirect_uri}&response_type=code&scope=read,read_all,profile:write&approval_prompt=force`);
});

app.get('/auth/strava/callback', (req, res) => {
    const code = req.query.code;
    const options = {
        url: 'https://www.strava.com/oauth/token',
        method: 'POST',
        json: true,
        body: {
            client_id: STRAVA_CLIENT_ID,
            client_secret: STRAVA_CLIENT_SECRET,
            code: code,
            grant_type: 'authorization_code'
        }
    };

    request(options, (error, response, body) => {
        if (error) return res.status(500).send(error);
        res.json(body);
    });
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
