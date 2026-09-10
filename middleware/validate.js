const Joi = require("joi");

const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) {
    const msg = error.details.map(d => d.message).join("; ");
    return res.status(400).json({ message: msg });
  }
  // Joi does not mutate the input — it returns a converted copy. Discarding `value` made
  // stripUnknown, .trim(), .lowercase() and .uppercase() silent no-ops: the controller went on
  // reading the raw body. Hand the sanitised object to the controller instead.
  req.body = value;
  next();
};

// Auth schemas
exports.validateSignup = validate(Joi.object({
  name:     Joi.string().trim().min(1).max(100).required(),
  email:    Joi.string().email().lowercase().required(),
  password: Joi.string().min(8).max(128).required(),
  timezone: Joi.string().max(64).optional(),
}));

exports.validateLogin = validate(Joi.object({
  email:    Joi.string().email().lowercase().required(),
  password: Joi.string().min(1).required(),
}));

// Shape only — whether the string names a real IANA zone is checked in the controller, which owns
// the fallback rule that goes with it.
exports.validateTimezone = validate(Joi.object({
  timezone: Joi.string().trim().max(64).required(),
}));

exports.validateForgotPassword = validate(Joi.object({
  email: Joi.string().email().lowercase().required(),
}));

// The six digits are validated as a shape only; whether they are the right six is the OTP
// helper's business. `code` is a string throughout so a leading zero survives JSON.
const otpCode = Joi.string().trim().pattern(/^\d{6}$/).required().messages({
  "string.pattern.base": "Enter the 6-digit code",
});

exports.validateResetPassword = validate(Joi.object({
  email:    Joi.string().email().lowercase().required(),
  code:     otpCode,
  password: Joi.string().min(8).max(128).required(),
}));

exports.validateVerifyOtp = validate(Joi.object({
  email: Joi.string().email().lowercase().required(),
  code:  otpCode,
}));

exports.validateResendOtp = validate(Joi.object({
  email:   Joi.string().email().lowercase().required(),
  purpose: Joi.string().valid("signup", "reset").required(),
}));

// Transaction schemas
exports.validateTransaction = validate(Joi.object({
  amount:              Joi.number().positive().required(),
  type:                Joi.string().valid("income", "expense").required(),
  category:            Joi.string().trim().min(1).required(),
  note:                Joi.string().allow("").max(500).optional(),
  date:                Joi.string().isoDate().optional(),
  currency:            Joi.string().length(3).uppercase().optional(),
  isRecurring:         Joi.boolean().optional(),
  recurrenceFrequency: Joi.string().valid("daily", "weekly", "monthly").allow(null).optional(),
  isPrivate:           Joi.boolean().optional(),
  // Validated for shape only. Ownership is checked in the controller — a well-formed ObjectId
  // belonging to another user must not be accepted just because it parses.
  accountId:           Joi.string().hex().length(24).allow(null, "").optional(),
}));

// Account schemas
exports.validateAccount = validate(Joi.object({
  name:           Joi.string().trim().min(1).max(60).required(),
  type:           Joi.string().valid("cash", "bank", "credit_card", "savings", "investment", "wallet", "other").optional(),
  openingBalance: Joi.number().optional(),
  color:          Joi.string().allow("").max(32).optional(),
  icon:           Joi.string().allow("").max(64).optional(),
}));
