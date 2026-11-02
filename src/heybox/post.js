const { API_BASE } = require("./constants");

const PATH_BBS_POST = "/bbs/app/api/link/post";
const PATH_BBS_DELETE = "/bbs/app/link/delete";

const DEFAULT_POST_TITLE = "前面忘了中间忘了后面也忘了";
const DEFAULT_POST_CONTENT = "孩子很爱用，很好吃，会复购";
const DEFAULT_REVIEW_CONTENT = "好玩推荐游戏体验非常好";

async function postTopic(appClient, topicId, title, content) {
  const text = JSON.stringify([{ checked: false, text: content, type: "text" }]);

  const postData = {
    draft: "0",
    topic_ids: String(topicId),
    link_tag: "27",
    text: text,
    title: title,
    desc: content,
  };

  return appClient.postJson(PATH_BBS_POST, {}, postData, { baseUrl: API_BASE });
}

async function postGameReview(appClient, appId, score, content) {
  const postData = {
    link_tag: "3",
    appid: String(appId),
    score: String(score),
    text: JSON.stringify([{ type: "text", text: content }]),
    game_impression_post_type: "2",
  };

  return appClient.postJson(PATH_BBS_POST, { h_src: "" }, postData, { baseUrl: API_BASE });
}

async function deletePost(appClient, linkId) {
  return appClient.postJson(PATH_BBS_DELETE, {}, { link_id: String(linkId) }, { baseUrl: API_BASE });
}

module.exports = {
  PATH_BBS_POST,
  PATH_BBS_DELETE,
  DEFAULT_POST_TITLE,
  DEFAULT_POST_CONTENT,
  DEFAULT_REVIEW_CONTENT,
  postTopic,
  postGameReview,
  deletePost,
};
