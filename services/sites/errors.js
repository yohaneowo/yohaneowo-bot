// An error whose message is meant for chat users (e.g. "not supported yet"), shown instead of
// the generic "解析失败" reply. Messages of ordinary errors stay in the logs only.
class UserFacingError extends Error {
	constructor(userMessage) {
		super(userMessage);
		this.name = 'UserFacingError';
		this.userMessage = userMessage;
	}
}

module.exports = {
	UserFacingError,
};
