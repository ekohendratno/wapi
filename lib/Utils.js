const moment = require('moment');

exports.isValidPhoneNumber = (number) => {
    const phoneRegex = /^[0-9]{10,15}$/;
    return phoneRegex.test(number);
};

exports.isValidGroupId = (groupId) => {
    const groupIdRegex = /^[0-9]{18}@g\.us$/;
    return groupIdRegex.test(groupId);
};

exports.calculateLastActive = (updatedAt) => {
    const now = moment();
    const lastActiveTime = moment(updatedAt);
    const duration = moment.duration(now.diff(lastActiveTime));

    if (duration.asMinutes() < 1) {
        return 'Baru saja';
    } else if (duration.asHours() < 1) {
        return `${Math.floor(duration.asMinutes())} menit yang lalu`;
    } else if (duration.asDays() < 1) {
        return `${Math.floor(duration.asHours())} jam yang lalu`;
    } else {
        return `${Math.floor(duration.asDays())} hari yang lalu`;
    }
}


exports.authMiddleware = (req, res, next) => {
    if (!req.session.user) {
        return res.redirect('/auth/login');
    }
    next();
};


exports.redirectIfLoggedIn = (req, res, next) => {
    if (req.session.user) {
        const role = req.session.user.role;
        return res.redirect(`/${role}`);
    }
    next();
};

exports.requireRole = (role) => {
    return function (req, res, next) {
        if (!req.session.user || req.session.user.role !== role) {
        return res.redirect('/');
        }
        next();
    };
};
