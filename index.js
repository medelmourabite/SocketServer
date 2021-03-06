var app = require("express")();
var http = require("http").Server(app);
var io = require("socket.io")(http);
var SpellChecker = require("simple-spellchecker");
var admin = require("firebase-admin");
var randomWords = require("random-words");
var app = require("express");

var config = require("./chat-eng-game-firebase.json");

admin.initializeApp({
  credential: admin.credential.cert(config),
  databaseURL: "https://chat-eng-game.firebaseio.com/"
});

var db = admin.database();
var refQuestions = db.ref("games/quiz/questions/");
var refFirstLines = db.ref("games/story/firstLines/");
var refParams = db.ref("params/");
var refPlayers = db.ref("players/");

var params;

var lastPlayer = [];

var refRooms = db.ref("rooms/");
var questions = [];
var randomQuestion = [];
var waiting = [];
var preparing = [];
var usersInRoom = [];
var firstLines = [];

refQuestions.on("value", s => {
  questions = snapShotToArray(s);
});

refParams.on("value", s => {
  params = s.val();
  console.log(params);
});

refFirstLines.on("value", s => {
  firstLines = snapShotToArray(s);
});

var games = [];
var levels = [];
var players = [];
var tmpPlayers = [];

var wrongAnswer = [];
var typing = [];

var improvs = ["story", "hero", "apple", "king", "network", "banana"];
var improv = [];

var lastWord = [];

var lastPlayer = [];

io.on("connection", client => {
  client.on("join", data => {
    if (data.player && data.room) {
      client.join(data.room);

      if (!games[data.room]) {
        usersInRoom[data.room] = 0;
        waiting[data.room] = false;
        refRooms
          .child(data.room)
          .child("games")
          .on("value", s => {
            if (s.val()) {
              games[data.room] = s.val();
            } else {
              games[data.room] = {};
            }
            if (games[data.room].quiz && !waiting[data.room]) {
              prepareAsking(data.room);
            }

            if (games[data.room].story && !waiting[data.room]) {
              getRandomFirstLine(games[data.room].story, fl => {
                sendMessage(
                  data.room,
                  "Can you begin with: << " + fl.text + " >>",
                  100000
                );
              });

              refRooms
                .child(data.room)
                .child("players")
                .on("value", s => {
                  players[data.room] = [];
                  if (s.val()) {
                    Object.keys(s.val()).forEach(player => {
                      refPlayers.child(player + "/state/").once("value", s => {
                        if (
                          s.val() == "online" &&
                          players[data.room].indexOf(player) <= -1
                        ) {
                          players[data.room].push(player);
                        }
                      });
                    });
                    setTimeout(function() {
                      chouseRandomPlayer(data.room);
                    }, 500);
                  } else {
                    waiting[data.room] = false;
                    wrongAnswer[data.room] = null;
                    games[data.room] = null;
                  }
                });

              setTimeout(function() {
                sendImprov(data.room);
              }, 2000);
            }
            if (
              (games[data.room] &&
                !games[data.room].quiz &&
                !games[data.room].story) ||
              !games[data.room]
            ) {
              waiting[data.room] = false;
              wrongAnswer[data.room] = 0;
            }
          });
      }
      usersInRoom[data.room]++;

      if (!levels[data.room]) {
        refRooms
          .child(data.room)
          .child("level")
          .on("value", s => {
            levels[data.room] = s.val();
          });
      }
    }
  });

  client.on("leave", data => {
    client.leave(data.room);
    client.disconnect(true);
    usersInRoom[data.room]--;
    if (usersInRoom[data.room] == 0) {
      waiting[data.room] = false;
      wrongAnswer[data.room] = null;
      games[data.room] = null;
    }
  });

  client.on("message", data => {
    if (games[data.room]) {
      if (games[data.room].spellcheck) {
        spellCheck(data.message, ret => {
          io.to(client.id).emit("message", ret.message);
        });
      } else {
        io.to(client.id).emit("message", data.message);
      }
    }
  });

  client.on("correct_message", data => {
    if (games[data.room]) {
      if (games[data.room].quiz && waiting[data.room]) {
        checkAnswer(data.message, data.room, ret => {
          if (ret.ok == "wrong") {
            wrongAnswer[data.room]++;
            waiting[data.room] = wrongAnswer[data.room] < 3;
            if (!waiting[data.room]) {
              io.to(data.room).emit("wrong", {
                title: randomQuestion[data.room].answer,
                text: "The correct answer is ",
                gain: 0
              });
            }
          } else if (ret.ok == "correct") {
            waiting[data.room] = false;
            prepareAsking(data.room);
          }
          showResult(client, data.room, ret);
        });
      } else if (games[data.room].quiz && !waiting[data.room]) {
        prepareAsking(data.room);
      } else if (games[data.room].story && waiting[data.room]) {
        checkImprov(data.message, data.room, ret => {
          if (ret.ok == "wrong") {
            wrongAnswer[data.room]++;
            waiting[data.room] = wrongAnswer[data.room] < 3;
          } else if (ret.ok == "correct") {
            waiting[data.room] = false;
          }
          showResult(client, data.room, ret);
        });
      } else if (games[data.room].startWithEnd) {
        checkEndStart(data.message, data.room, ret => {
          showResult(client, data.room, ret);
          lastWord[data.room] = ret.lastWord;
        });
      }
    }
  });

  client.on("disconnect", function() {
    console.log("client disconnect...");
  });
});

function sendMessage(room, text, type) {
  refRooms
    .child(room + "/")
    .child("messages/")
    .push({
      date: new Date().getTime(),
      from: "chat-bot",
      text: text,
      type: type
    });
}

function showResult(client, room, ret) {
  if (ret.ok == "wrong") {
    io.to(client.id).emit(ret.ok, ret.message);
  } else if (ret.ok == "correct") {
    io.to(room).emit(ret.ok, ret.message);
    io.to(client.id).emit("congrat", {
      title: "Congratulation",
      text: "you win " + ret.message.gain + " points",
      gain: ret.message.gain
    });
  }
}

function spellCheck(message, cb) {
  SpellChecker.getDictionary(
    "en-US",
    "./node_modules/simple-spellchecker/dict",
    function(err, dictionary) {
      if (!err) {
        var wordsTmp = message.text
          .replace(/[,.*+?^${}()|[\]\\\n\t]/g, " ")
          .split(" ");
        var words = wordsTmp.filter((item, pos) => {
          return wordsTmp.indexOf(item) == pos;
        });
        words.forEach(word => {
          if (word != "") {
            var misspelled = !dictionary.spellCheck(word);
            if (misspelled) {
              message.isCorrect = false;
              message.suggestions.push({
                word,
                suggestions: dictionary.getSuggestions(word)
              });
            }
          }
        });
        return cb({
          message
        });
      }
    }
  );
}

function prepareAsking(room) {
  if (preparing[room] || waiting[room]) {
    return;
  }
  preparing[room] = true;
  var timeOut = Math.floor(
    Math.random() * (params ? params.minTime : 60) +
      (params ? params.minTime : 30)
  );
  var message = {
    title: "ready",
    text: "next question in " + timeOut + " seconds",
    time: timeOut
  };
  io.to(room).emit("ready", message);
  setTimeout(function() {
    preparing[room] = false;
    ask(room);
  }, timeOut * 1000);
}

function ask(room) {
  getRandom(levels[room], rq => {
    randomQuestion[room] = rq;
    if (games[room] && games[room].quiz && randomQuestion[room]) {
      sendMessage(
        room,
        randomQuestion[room].question,
        randomQuestion[room].type
      );
      waiting[room] = true;
      wrongAnswer[room] = 0;
    } else if (games[room] && games[room].quiz) {
      setTimeout(function() {
        ask(room);
      }, 1000);
    }
  });
}

function getRandom(level, cb) {
  var q;
  while (true) {
    q = questions[Math.floor(Math.random() * questions.length)];
    // q = questions[1];
    if (q && q.level && q.level <= level) {
      break;
    }
  }
  cb(q);
}

function checkAnswer(message, room, cb) {
  if (!randomQuestion[room]) return;
  var answer = randomQuestion[room].answer;
  if (message.text.toLowerCase() == answer.toLowerCase()) {
    cb({
      ok: "correct",
      message: {
        title: "correct",
        text: "The answer is << " + answer + " >>",
        player: message.from,
        gain: Math.floor(Math.pow(randomQuestion[room].level + 1, 1.6))
      }
    });
  } else {
    cb({
      ok: "wrong",
      message: {
        title: "wrong",
        text: "Try again",
        player: message.from,
        gain: 0
      }
    });
  }
}

function getRandomFirstLine(genre, cb) {
  var fl;
  var tmp = firstLines;
  if (genre && genre < 20) {
    var tmp = firstLines.filter(item => {
      return item.genre == genre;
    });
  }
  while (true) {
    fl = tmp[Math.floor(Math.random() * tmp.length)];
    if (fl) {
      break;
    }
  }
  cb(fl);
}

function chouseRandomPlayer(room) {
  var index;
  do {
    if (!players[room] || players[room].length <= 0) return;
    if (!tmpPlayers || !tmpPlayers[room] || tmpPlayers[room].length <= 0) {
      tmpPlayers[room] = players[room].filter(() => {
        return true;
      });
    }
    index = Math.floor(Math.random() * tmpPlayers[room].length);
    var r = tmpPlayers[room][index];
  } while (!r || players[room].indexOf(r) <= -1 || r == lastPlayer[room]);
  lastPlayer[room] = r;

  tmpPlayers[room].splice(index, 1);

  io.to(room).emit("your_turn", {
    uid: r
  });
}

function sendImprov(room) {
  var count = 0;
  var interval = setInterval(() => {
    if (games[room] && !games[room].story) {
      waiting[room] = false;
      clearInterval(interval);
    }
    // if((!waiting[room] && count > (params ? params.minTime : 10)) || count > (params ? params.timeOut : 30))
    if (!waiting[room] || count > (params ? params.timeOut : 30)) {
      improv[room] = randomWords({
        min: 2,
        max: 4,
        formatter: word => word.toLowerCase()
      });
      sendMessage(room, "Next words are :\n" + improv[room], 10000);
      waiting[room] = true;
      count = 0;
      setTimeout(function() {
        chouseRandomPlayer(room);
      }, 800);
    }
    count++;
  }, 1000);
}

function checkImprov(message, room, cb) {
  if (!improv[room]) return;
  var wordsTmp = message.text
    .replace(/[,.*+?^${}()|[\]\\\n\t]/g, " ")
    .split(" ");

  if (arraysEqual(wordsTmp, improv[room]) >= wordsTmp.length) {
    cb({
      ok: "wrong",
      message: {
        title: "Cheating is prohibited",
        text: "You lose 25 points",
        player: message.from,
        gain: -25
      }
    });
    return;
  }

  for (var i = wordsTmp.length - 1; i >= 0; i--) {
    if (
      wordsTmp.length > 1 &&
      improv[room].indexOf(wordsTmp[i].toLowerCase()) > -1
    ) {
      cb({
        ok: "correct",
        message: {
          title: "Well done",
          text: "You are a master story teller",
          player: message.from,
          gain: 5
        }
      });
      return;
    }
  }
  cb({
    ok: "wrong",
    message: {
      title: "You can do better",
      text: "Try to be more imaginative",
      player: message.from,
      gain: 0
    }
  });
}

function checkEndStart(message, room, cb) {
  if (games[room].startWithEnd == "leter") {
    checkLastLeter(message, room, cb);
  } else {
    checkLastWord(message, room, cb);
  }
}

function checkLastWord(message, room, cb) {
  var wordsTmp = message.text
    .replace(/[,.*+?^${}()|[\]\\\n\t]/g, " ")
    .split(" ");

  if (wordsTmp.length <= 1) return;
  if (!lastWord[room]) {
    lastWord[room] = wordsTmp[wordsTmp.length - 1];
    return;
  }

  if (lastWord[room].toLowerCase() == wordsTmp[0].toLowerCase()) {
    cb({
      ok: "correct",
      lastWord: wordsTmp[wordsTmp.length - 1],
      message: {
        title: "correct",
        text: "Well done",
        player: message.from,
        gain: 6
      }
    });
  } else {
    cb({
      ok: "wrong",
      lastWord: wordsTmp[wordsTmp.length - 1],
      message: {
        title: "wrong",
        text: "You have to start with the last word",
        player: message.from,
        gain: -1
      }
    });
  }
}

function checkLastLeter(message, room, cb) {
  var leter = message.text[0];

  if (message.text.length <= 1) return;
  var newLast = message.text[message.text.length - 1];

  if (!lastWord[room]) {
    lastWord[room] = newLast;
    return;
  }

  if (lastWord[room].toLowerCase() == leter.toLowerCase()) {
    cb({
      ok: "correct",
      lastWord: newLast,
      message: {
        title: "correct",
        text: "Well done",
        player: message.from,
        gain: 3
      }
    });
  } else {
    cb({
      ok: "wrong",
      lastWord: newLast,
      message: {
        title: "wrong",
        text: "You have to start with the last leter",
        player: message.from,
        gain: -1
      }
    });
  }
}

const snapShotToArray = snapShot => {
  var arr = [];
  snapShot.forEach(element => {
    var item = element.val();
    item.key = element.key;
    arr.push(item);
  });
  return arr;
};

function arraysEqual(arr1, arr2) {
  var k = 0;
  for (var i = arr1.length; i--; ) {
    if (arr2.indexOf(arr1[i]) > -1) k++;
  }
  return k;
}

var port = process.env.PORT || 8888;
var host = "http://localhost:";

http.listen(port, function() {
  console.log("http://localhost:" + port);
});

// app.get('/', (res ,req) => {
//   res.send("Listening " + port);
// });
