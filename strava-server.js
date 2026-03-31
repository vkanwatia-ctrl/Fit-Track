const express = require('express');
const session = require('express-session');
const passport = require('passport');
const StravaStrategy = require('passport-strava-oauth2').Strategy;

const app = express();
const PORT = process.env.PORT || 3000;

// Configure session middleware
app.use(session({
    secret: 'your-secret-key',
    resave: false,
    saveUninitialized: true,
}));

app.use(passport.initialize());
app.use(passport.session());

// Configure Strava strategy for Passport
passport.use(new StravaStrategy({
    clientID: 'YOUR_CLIENT_ID',
    clientSecret: 'YOUR_CLIENT_SECRET',
    callbackURL: 'http://localhost:3000/auth/strava/callback',
}, (accessToken, refreshToken, profile, done) => {
    // Save user profile and tokens to the session
    return done(null, profile);
}));

passport.serializeUser((user, done) => {
    done(null, user);
});

passport.deserializeUser((user, done) => {
    done(null, user);
});

// Routes
app.get('/auth/strava', passport.authenticate('strava'));  

app.get('/auth/strava/callback', passport.authenticate('strava', {
    failureRedirect: '/'  
}), (req, res) => {
    // Successful authentication, redirect home.
    res.redirect('/');
});

app.get('/', (req, res) => {
    res.send('<h1>Home</h1>');
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
