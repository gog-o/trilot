const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

let players = []; 
let playerNames = {}; // Обект, който ще пази: socket.id -> "Гого", "Виктор" или "Моньо"

let gameState = {
    deck: [],
    hands: {},
    roundScores: {},
    announcements: {},
    totalScores: {},
    announcer: null,
    gameType: null,
    currentTrick: [],
    currentTurnIndex: 0,
    dealerIndex: -1,
    ledSuit: null,
    phase: 'WAITING',
    highestBid: { type: null, value: 0, playerId: null },
    passCount: 0,
    lastTrickWinner: null
};

const bidValues = { '♦': 1, '♠': 2, '♥': 3, 'БЕЗ_КОЗ': 4, 'ВСИЧКО_КОЗ': 5 };

function createDeck() {
    const suits = ['♦', '♠', '♥'];
    const values = ['3', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    let deck = [];
    for (let suit of suits) {
        for (let value of values) {
            deck.push({ value, suit });
        }
    }
    return deck;
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function getCardPower(card, ledSuit, gameType) {
    const value = card.value;
    if (value === '3') return (card.suit === ledSuit) ? 1 : 0;

    const isSingleSuitTrump = ['♦', '♠', '♥'].includes(gameType);
    if (isSingleSuitTrump && card.suit === gameType && ledSuit !== gameType) {
        const trumpPowerMap = { '7': 20, '8': 21, 'Q': 22, 'K': 23, '10': 24, 'A': 25, '9': 26, 'J': 27 };
        return trumpPowerMap[value] || 0;
    }

    if (card.suit !== ledSuit && (!isSingleSuitTrump || card.suit !== gameType)) {
        return 0;
    }

    if (gameType === 'ВСИЧКО_КОЗ' || (isSingleSuitTrump && card.suit === gameType)) {
        const powerMap = { '7': 2, '8': 3, 'Q': 4, 'K': 5, '10': 6, 'A': 7, '9': 8, 'J': 9 };
        return powerMap[value] || 0;
    } 
    
    const powerMap = { '7': 2, '8': 3, '9': 4, 'J': 5, 'Q': 6, 'K': 7, '10': 8, 'A': 9 };
    return powerMap[value] || 0;
}

function getStandardCardPoints(card, gameType, ledSuit) {
    const value = card.value;
    
    if (value === '3') {
        if (gameType === 'БЕЗ_КОЗ') return 0;
        if (gameType === 'ВСИЧКО_КОЗ') {
            return (card.suit === ledSuit) ? 3 : 9;
        }
        return 3; 
    }

    if (gameType === 'ВСИЧКО_КОЗ') {
        const points = { '7': 0, '8': 0, '9': 14, 'J': 20, 'Q': 3, 'K': 4, '10': 10, 'A': 11 };
        return points[value] || 0;
    }

    if (['♦', '♠', '♥'].includes(gameType)) {
        if (card.suit === gameType) {
            const points = { '7': 0, '8': 0, '9': 14, 'J': 20, 'Q': 3, 'K': 4, '10': 10, 'A': 11 };
            return points[value] || 0;
        } else {
            const points = { '7': 1, '8': 1, '9': 1, 'J': 2, 'Q': 3, 'K': 4, '10': 10, 'A': 11 };
            return points[value] || 0;
        }
    }

    if (gameType === 'БЕЗ_КОЗ') {
        const points = { '7': 1, '8': 1, '9': 1, 'J': 2, 'Q': 3, 'K': 4, '10': 10, 'A': 11 };
        return points[value] || 0;
    }

    return 0;
}

function sortHand(hand, gameType) {
    const suitOrder = { '♦': 1, '♠': 2, '♥': 3 };
    return hand.sort((a, b) => {
        if (a.suit !== b.suit) {
            return suitOrder[a.suit] - suitOrder[b.suit];
        }
        return getCardPower(a, a.suit, gameType) - getCardPower(b, b.suit, gameType);
    });
}

function evaluateAnnouncements(hand, gameType) {
    let points = 0;
    let textList = [];
    let counts = {};
    
    hand.forEach(c => counts[c.value] = (counts[c.value] || 0) + 1);
    
    for (let val in counts) {
        if (counts[val] === 3) {
            if (val === '3' && gameType === 'БЕЗ_КОЗ') {
                points += 33;
                textList.push("Трилот от 3ки (33 т.)");
            }
            else if (['10', 'Q', 'K', 'A'].includes(val)) {
                points += 40;
                textList.push(`Триада от ${val} (40 т.)`);
            }
            else if (val === '9') {
                points += 50;
                textList.push("Триада от 9ки (50 т.)");
            }
            else if (val === 'J') {
                points += 60;
                textList.push("Триада от Валета (60 т.)");
            }
        }
    }
    return { points: points, text: textList.join(', ') || "Няма" };
}

function assignNamesToPlayers() {
    let availableNames = ["Гого", "Виктор", "Моньо"];
    let shuffledNames = shuffle(availableNames); // Разбъркваме имената на случаен принцип
    
    players.forEach((id, index) => {
        playerNames[id] = shuffledNames[index];
    });
    console.log("Имената за тази сесия са разпределени:", playerNames);
}

function startNewRound() {
    gameState.deck = shuffle(createDeck());
    gameState.currentTrick = [];
    gameState.ledSuit = null;
    gameState.phase = 'BIDDING';
    gameState.highestBid = { type: null, value: 0, playerId: null };
    gameState.passCount = 0;
    gameState.lastTrickWinner = null;

    if (gameState.dealerIndex === -1) {
        gameState.dealerIndex = Math.floor(Math.random() * 3);
    } else {
        gameState.dealerIndex = (gameState.dealerIndex + 2) % 3;
    }

    players.forEach(id => {
        gameState.hands[id] = [];
        gameState.roundScores[id] = 0;
        gameState.announcements[id] = { points: 0, text: "Няма" };
        if (gameState.totalScores[id] === undefined) gameState.totalScores[id] = 0;
    });

    let currentDealIndex = (gameState.dealerIndex + 2) % 3; 
    for (let k = 0; k < 3; k++) {
        let pId = players[currentDealIndex];
        gameState.hands[pId].push(...gameState.deck.splice(0, 6));
        sortHand(gameState.hands[pId], 'БЕЗ_КОЗ');
        currentDealIndex = (currentDealIndex + 2) % 3;
    }

    gameState.currentTurnIndex = (gameState.dealerIndex + 2) % 3;
    sendGameStateToAll();
}

function finishDealing() {
    gameState.phase = 'PLAYING';
    gameState.gameType = gameState.highestBid.type;
    gameState.announcer = gameState.highestBid.playerId;

    let currentDealIndex = (gameState.dealerIndex + 2) % 3;
    for (let k = 0; k < 3; k++) {
        let pId = players[currentDealIndex];
        gameState.hands[pId].push(...gameState.deck.splice(0, 3));
        gameState.announcements[pId] = evaluateAnnouncements(gameState.hands[pId], gameState.gameType);
        sortHand(gameState.hands[pId], gameState.gameType);
        currentDealIndex = (currentDealIndex + 2) % 3;
    }

    gameState.currentTurnIndex = players.indexOf(gameState.announcer);
    sendGameStateToAll();
}

function sendGameStateToAll() {
    players.forEach((id, index) => {
        io.to(id).emit('gameState', {
            hand: gameState.hands[id],
            yourIndex: index,
            currentTrick: gameState.currentTrick,
            currentTurn: players[gameState.currentTurnIndex],
            totalScores: gameState.totalScores,
            gameType: gameState.gameType,
            announcer: gameState.announcer,
            phase: gameState.phase,
            highestBid: gameState.highestBid,
            dealer: players[gameState.dealerIndex],
            announcementText: gameState.announcements[id].text,
            announcementPoints: gameState.announcements[id].points,
            playerNamesMap: playerNames // Изпращаме мапа с имената към браузъра
        });
    });
}

// КОРЕКЦИЯ: Взема имената Гого, Виктор или Моньо вместо служебния ID низ
function getPlayerDisplay(id) {
    return playerNames[id] || "Наблюдател";
}

function customRoundScores(scoresMap, gameType) {
    let rounded = {};
    let raw = { ...scoresMap };

    if (gameType === 'БЕЗ_КОЗ') {
        players.forEach(id => {
            let doubled = (raw[id] || 0) * 2;
            let remainder = doubled % 10;
            rounded[id] = (remainder >= 5) ? Math.ceil(doubled / 10) : Math.floor(doubled / 10);
        });
        return rounded;
    }

    if (gameType === 'ВСИЧКО_КОЗ') {
        let minPlayerId = players.reduce((minId, id) => (raw[id] || 0) < (raw[minId] || 0) ? id : minId, players);
        players.forEach(id => {
            let remainder = (raw[id] || 0) % 10;
            let threshold = (id === minPlayerId) ? 4 : 5;
            rounded[id] = (remainder >= threshold) ? Math.ceil((raw[id] || 0) / 10) : Math.floor((raw[id] || 0) / 10);
        });
        return rounded;
    }

    if (['♦', '♠', '♥'].includes(gameType)) {
        let minPlayerId = players.reduce((minId, id) => (raw[id] || 0) < (raw[minId] || 0) ? id : minId, players);
        players.forEach(id => {
            let remainder = (raw[id] || 0) % 10;
            let threshold = (id === minPlayerId) ? 6 : 5;
            rounded[id] = (remainder >= threshold) ? Math.ceil((raw[id] || 0) / 10) : Math.floor((raw[id] || 0) / 10);
        });
        return rounded;
    }

    players.forEach(id => rounded[id] = Math.round((raw[id] || 0) / 10));
    return rounded;
}

function processEndRound() {
    if (gameState.lastTrickWinner) {
        gameState.roundScores[gameState.lastTrickWinner] += 10;
    }

    let finalScoresThisRound = {};
    players.forEach(id => {
        finalScoresThisRound[id] = (gameState.roundScores[id] || 0) + (gameState.announcements[id].points || 0);
    });

    let roundedScores = customRoundScores(finalScoresThisRound, gameState.gameType);
    const announcerId = gameState.announcer;
    const announcerPoints = roundedScores[announcerId] || 0;

    let isInside = false;
    players.forEach(id => {
        if (id !== announcerId && (roundedScores[id] || 0) > announcerPoints) isInside = true;
    });

    let roundLog = {};
    if (isInside) {
        const bonus = Math.floor(announcerPoints / 2);
        players.forEach(id => {
            if (id === announcerId) {
                roundLog[id] = 0;
	    } else {
		roundLog[id] = (roundedScores[id] || 0) + bonus;
                gameState.totalScores[id] += roundLog[id];
            }
        });
    } else {
        players.forEach(id => {
            roundLog[id] = roundedScores[id] || 0;
            gameState.totalScores[id] += roundLog[id];
        });
    }

    let winner = null;
    players.forEach(id => {
        if (gameState.totalScores[id] >= 111) {
            if (!winner || gameState.totalScores[id] > gameState.totalScores[winner]) {
                winner = id;
            }
        }
    });

    if (winner) {
        io.emit('gameOver', { winner: getPlayerDisplay(winner), scores: gameState.totalScores });
        players.forEach(id => gameState.totalScores[id] = 0);
        gameState.dealerIndex = -1;
    } else {
        let details = "Край на разиграването!\n\nТочки от този кръг:\n";
        players.forEach(id => {
            details += `${getPlayerDisplay(id)}: +${roundLog[id] || 0} т. (Общо в мача: ${gameState.totalScores[id]} т.)\n`;
        });
        io.emit('roundOver', { details });
        startNewRound();
    }
}

io.on('connection', (socket) => {
    if (players.length < 3 && !players.includes(socket.id)) {
        players.push(socket.id);
    } else {
        return socket.disconnect();
    }

    if (players.length === 3) {
        assignNamesToPlayers(); // Щом се закачат и тримата, раздаваме имената им
        startNewRound();
    }

    socket.on('submitBid', (bidType) => {
        if (gameState.phase !== 'BIDDING' || players[gameState.currentTurnIndex] !== socket.id) return;

        if (bidType === 'ПАС') {
            gameState.passCount++;
            if (gameState.passCount === 3 && !gameState.highestBid.type) {
                startNewRound();
                return;
            } else if (gameState.passCount === 2 && gameState.highestBid.type) {
                finishDealing();
                return;
            }
        } else {
            const bidVal = bidValues[bidType] || 0;
            if (bidVal > gameState.highestBid.value) {
                gameState.highestBid = { type: bidType, value: bidVal, playerId: socket.id };
                gameState.passCount = 0;
            } else {
                socket.emit('errorMsg', 'Трябва да наддадете по-висока игра!');
                return;
            }
        }

        gameState.currentTurnIndex = (gameState.currentTurnIndex + 2) % 3;
        sendGameStateToAll();
    });

    socket.on('playCard', (cardIndex) => {
        if (gameState.phase !== 'PLAYING') return;
        const playerIndex = players.indexOf(socket.id);
        if (playerIndex !== gameState.currentTurnIndex) return;

        const card = gameState.hands[socket.id][cardIndex];
        
        if (gameState.currentTrick.length > 0 && card.value !== '3') {
            const hasLedSuit = gameState.hands[socket.id].some(c => c.suit === gameState.ledSuit);
            
            if (hasLedSuit && card.suit !== gameState.ledSuit) {
                socket.emit('errorMsg', 'Длъжен сте да отговорите на искания цвят (или пуснете Тройка)!');
                return;
            }

            if (gameTypeIsTrump(gameState.gameType, gameState.ledSuit) && card.suit === gameState.ledSuit) {
                let highestTrickPower = 0;
                gameState.currentTrick.forEach(item => {
                    let p = getCardPower(item.card, gameState.ledSuit, gameState.gameType);
                    if (p > highestTrickPower) highestTrickPower = p;
                });

                const myPower = getCardPower(card, gameState.ledSuit, gameState.gameType);
                const hasStrongerCard = gameState.hands[socket.id].some(c => 
                    c.suit === gameState.ledSuit && 
                    getCardPower(c, gameState.ledSuit, gameState.gameType) > highestTrickPower
                );

                if (hasStrongerCard && myPower <= highestTrickPower) {
                    socket.emit('errorMsg', 'Трябва да качите над най-силната карта на масата!');
                    return;
                }
            }
        }

        if (gameState.currentTrick.length === 0) gameState.ledSuit = card.suit;

        gameState.hands[socket.id].splice(cardIndex, 1);
        gameState.currentTrick.push({ playerId: socket.id, card });
        
        gameState.currentTurnIndex = (gameState.currentTurnIndex + 2) % 3;

        if (gameState.currentTrick.length === 3) {
            setTimeout(() => {
                let winnerCardItem = gameState.currentTrick;
                let maxPower = getCardPower(winnerCardItem.card, gameState.ledSuit, gameState.gameType);

                for (let i = 1; i < 3; i++) {
                    let currentPower = getCardPower(gameState.currentTrick[i].card, gameState.ledSuit, gameState.gameType);
                    if (currentPower > maxPower) {
                        maxPower = currentPower;
                        winnerCardItem = gameState.currentTrick[i];
                    }
                }

                let trickPoints = 0;
                gameState.currentTrick.forEach(item => {
                    trickPoints += getStandardCardPoints(item.card, gameState.gameType, gameState.ledSuit);
                });

                const trickWinnerId = winnerCardItem.playerId;
                gameState.roundScores[trickWinnerId] = (gameState.roundScores[trickWinnerId] || 0) + trickPoints;
                gameState.lastTrickWinner = trickWinnerId;
                
                gameState.currentTurnIndex = players.indexOf(trickWinnerId);
                gameState.currentTrick = [];
                gameState.ledSuit = null;

                const checkPlayerId = players;
                if (gameState.hands[checkPlayerId] && gameState.hands[checkPlayerId].length === 0) {
                    processEndRound();
                } else {
                    sendGameStateToAll();
                }
            }, 1200);
        }
        sendGameStateToAll();
    });

    socket.on('disconnect', () => {
        players = players.filter(id => id !== socket.id);
        delete playerNames[socket.id]; // Премахваме името при напускане
        gameState.phase = 'WAITING';
        gameState.dealerIndex = -1;
    });
});

function gameTypeIsTrump(gameType, ledSuit) {
    if (gameType === 'ВСИЧКО_КОЗ') return true;
    if (['♦', '♠', '♥'].includes(gameType) && ledSuit === gameType) return true;
    return false;
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Сървърът на Трилот работи на порт ${PORT}`));
