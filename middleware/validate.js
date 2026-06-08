const Joi = require("joi");

const validate = (schema) => (req, res, next) => {
  const { error } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) {
    const msg = error.details.map(d => d.message).join("; ");
    return res.status(400).json({ message: msg });
  }
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

exports.validateForgotPassword = validate(Joi.object({
  email: Joi.string().email().lowercase().required(),
}));

exports.validateResetPassword = validate(Joi.object({
  password: Joi.string().min(8).max(128).required(),
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
}));
