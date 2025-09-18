import * as THREE from 'three';
import * as CANNON from 'cannon-es';

declare var Peer: any;

// --- Typdefinitionen ---

enum DieType {
    Attribute = 'attribute',
    Skill = 'skill',
    Bonus = 'bonus',
}

interface DieConfig {
    color: number;
    textColor: string;
    type: DieType;
}

interface DieObject {
    mesh: THREE.Mesh;
    body: CANNON.Body;
    type: DieType;
    settled: boolean;
    result: number;
    playerId: string;
}

// Data for initiating a roll, broadcast to all clients
interface RollInitiation {
    type: 'initiate';
    id: string;
    playerId:string;
    dice: { type: DieType, count: number }[];
    clearScreen: boolean;
}

// Data for the final results, broadcast from the roller
interface DieState {
    type: DieType;
    result: number;
}
interface RollResult {
    type: 'result';
    id: string; // Corresponds to the RollInitiation id
    playerId: string;
    diceStates: DieState[];
    isReroll: boolean;
}

// Data for clearing a player's dice from GM screen
interface ClearAction {
    type: 'clear';
    id: string;
    playerId: string;
}

interface PlayerNameUpdate {
    type: 'name_update';
    playerId: string;
    name: string;
}


type BroadcastMessage = RollInitiation | RollResult | ClearAction | PlayerNameUpdate;


// --- Konstanten ---
const GM_PEER_SUFFIX = '-gm';

const BASE_DICE_CONFIG: Record<DieType, DieConfig> = {
    [DieType.Attribute]: { color: 0x87ceeb, textColor: '#000000', type: DieType.Attribute },
    [DieType.Skill]: { color: 0xffa500, textColor: '#000000', type: DieType.Skill },
    [DieType.Bonus]: { color: 0x90ee90, textColor: '#000000', type: DieType.Bonus },
};

const RESULT_COLORS = {
    success: 0x006400, // Dunkelgrün
    failure: 0x8b0000, // Dunkelrot
    patzerArrange: 0xffff00, // Gelb
};

const DIE_SIZE = 0.5;
const GRAVITY = -20;
const SETTLE_THRESHOLD = 0.1;
const PROCESSED_ROLL_TTL_MS = 5 * 60 * 1000;

class HeliosDiceRoller {
    private renderer!: THREE.WebGLRenderer;
    private scene!: THREE.Scene;
    private camera!: THREE.PerspectiveCamera;
    private physicsWorld!: CANNON.World;
    private dice: DieObject[] = [];
    private groundMaterial!: CANNON.Material;
    private diceMaterial!: CANNON.Material;
    private settlingTimeout: number | null = null;
    private wallBodies: CANNON.Body[] = [];
    private playArea: { width: number, height: number } = { width: 0, height: 0 };
    private clock = new THREE.Clock();
    private animatingDice: {
        die: DieObject;
        startPos: THREE.Vector3;
        endPos: THREE.Vector3;
        startQuat: THREE.Quaternion;
        endQuat: THREE.Quaternion;
        progress: number;
    }[] = [];
    private animationDuration = 1.5;
    private processedRolls: Map<string, number> = new Map();
    private dieTextureCache: Map<string, THREE.CanvasTexture> = new Map();

    // Networking
    private peer: any | null = null;
    private currentPeerId: string | null = null;
    private connections: Record<string, any> = {}; // GM stores player connections
    private gmConnection: any | null = null; // Player stores connection to GM
    private sessionId: string | null = null;
    private lastInitiatedRollId: string | null = null;
    private playerNames: Record<string, string> = {};

    // View Management
    private playerId: string | null = null;
    private playerName: string | null = null;
    private isGMView: boolean = false;
    private currentRollIsNew: boolean = true;
    
    // UI Elemente
    private launcherContainer!: HTMLElement;
    private uiContainer!: HTMLElement;
    private mainControls!: HTMLElement;
    private collapsedUI!: HTMLElement;
    private hideUIButton!: HTMLButtonElement;
    private showUIButton!: HTMLButtonElement;
    private isUIVisible: boolean = true;
    private attributeInput!: HTMLInputElement;
    private skillInput!: HTMLInputElement;
    private bonusInput!: HTMLInputElement;
    private rollButton!: HTMLButtonElement;
    private rerollButton!: HTMLButtonElement;
    private attributeResults!: HTMLElement;
    private skillResults!: HTMLElement;
    private bonusResults!: HTMLElement;
    private rollLogContainer!: HTMLElement;
    private rerollUsed: boolean = false;


    constructor() {
        this.setupSession();
        this.initScene();
        this.initPhysics();
        this.initUI();
        this.handleRouteChange();
        window.addEventListener('resize', this.onWindowResize.bind(this));
        window.addEventListener('hashchange', this.handleRouteChange.bind(this));
        this.animate();
    }

    private setupSession(): void {
        const urlParams = new URLSearchParams(window.location.search);
        let sessionId = urlParams.get('session');
        let needsUpdate = false;
    
        if (!sessionId) {
            sessionId = 'helios-' + (Date.now().toString(36) + Math.random().toString(36).substring(2, 9));
            needsUpdate = true;
        }
        this.sessionId = sessionId;
    
        // Preserve other query params like 'name' if they exist, but update session
        urlParams.set('session', this.sessionId);
        const newUrl = `${window.location.pathname}?${urlParams.toString()}${window.location.hash}`;

        if (needsUpdate) {
            window.history.replaceState({ path: newUrl }, '', newUrl);
        }
    }
    
    private initNetworking(): void {
        if (!this.sessionId || (!this.playerId && !this.isGMView)) {
            this.teardownNetworking();
            return;
        }

        const desiredPeerId = this.isGMView ? `${this.sessionId}${GM_PEER_SUFFIX}` : `${this.sessionId}-${this.playerId}`;

        if (this.peer && !this.peer.destroyed && this.currentPeerId === desiredPeerId) {
            return;
        }

        this.teardownNetworking();

        try {
            this.peer = new Peer(desiredPeerId);
            this.currentPeerId = desiredPeerId;
        } catch (e) {
            this.currentPeerId = null;
            console.error('Failed to initialize PeerJS. Make sure the library is loaded.', e);
            return;
        }

        this.peer.on('open', (id: string) => {
            console.log('PeerJS initialized. My ID is: ' + id);
            if (!this.isGMView && this.playerId) {
                this.connectToGm();
            }
        });

        this.peer.on('connection', (conn: any) => {
            if (this.isGMView) {
                console.log(`Player ${conn.peer} connected.`);
                this.connections[conn.peer] = conn;
                conn.on('data', (data: BroadcastMessage) => {
                    this.handleNetworkData(data, conn.peer);
                });
                conn.on('close', () => this.handlePlayerDisconnect(conn.peer));
            }
        });

        this.peer.on('error', (err: any) => {
            console.error('PeerJS Error:', err);
            if (err.type === 'peer-unavailable') {
                alert('Could not connect to the Game Master. Please ensure the GM View is open and the session URL is correct.');
            }
        });
    }

    private teardownNetworking(): void {
        Object.values(this.connections).forEach(conn => {
            try {
                conn.close();
            } catch (error) {
                console.warn('Error while closing player connection.', error);
            }
        });
        this.connections = {};

        if (this.gmConnection) {
            try {
                this.gmConnection.close();
            } catch (error) {
                console.warn('Error while closing GM connection.', error);
            }
            this.gmConnection = null;
        }

        if (this.peer) {
            try {
                this.peer.destroy();
            } catch (error) {
                console.warn('Error while destroying peer.', error);
            }
            this.peer = null;
        }

        this.currentPeerId = null;
        this.playerNames = {};
    }

    private handlePlayerDisconnect(peerId: string): void {
        delete this.connections[peerId];
        const playerId = Object.keys(this.playerNames).find(pId => peerId.endsWith(pId));
        if (playerId) {
            const name = this.playerNames[playerId];
            console.log(`Player ${name ?? playerId} (${peerId}) disconnected.`);
            delete this.playerNames[playerId];
        }
    }

    private markMessageProcessed(key: string): boolean {
        const now = Date.now();
        const seenAt = this.processedRolls.get(key);
        if (seenAt !== undefined && now - seenAt < PROCESSED_ROLL_TTL_MS) {
            return false;
        }

        this.cleanupProcessedRolls(now);
        this.processedRolls.set(key, now);
        return true;
    }

    private cleanupProcessedRolls(currentTime: number = Date.now()): void {
        const keysToDelete: string[] = [];
        this.processedRolls.forEach((timestamp, key) => {
            if (currentTime - timestamp > PROCESSED_ROLL_TTL_MS) {
                keysToDelete.push(key);
            }
        });
        keysToDelete.forEach(key => this.processedRolls.delete(key));
    }

    private connectToGm(): void {
        if (!this.sessionId || !this.peer || (this.gmConnection && this.gmConnection.open)) return;
        const gmPeerId = this.sessionId + GM_PEER_SUFFIX;
        console.log(`Player attempting to connect to GM at ${gmPeerId}`);
        this.gmConnection = this.peer.connect(gmPeerId);

        this.gmConnection.on('open', () => {
            console.log('Connection to GM established!');
            this.sendNameUpdate();
        });
    
        this.gmConnection.on('data', (data: BroadcastMessage) => {
            this.handleNetworkData(data);
        });
    
        this.gmConnection.on('close', () => {
            console.log('Connection to GM lost.');
            this.gmConnection = null;
        });
    }
    
    private broadcast(data: BroadcastMessage, options?: { excludePeerId?: string }): void {
        if (this.isGMView) { // GM broadcasts to all players
            Object.entries(this.connections).forEach(([peerId, conn]) => {
                if (options?.excludePeerId && peerId === options.excludePeerId) return;
                const sendToConnection = () => {
                    try {
                        conn.send(data);
                    } catch (error) {
                        console.warn(`Failed to send data to peer ${peerId}.`, error);
                        if (!conn.open) {
                            this.handlePlayerDisconnect(peerId);
                        }
                    } finally {
                        if (typeof conn.off === 'function') {
                            conn.off('open', sendToConnection);
                        }
                    }
                };

                if (conn.open) {
                    sendToConnection();
                } else {
                    conn.on('open', sendToConnection);
                }
            });
        } else if (this.gmConnection) { // Player sends to GM
            const sendToGm = () => {
                try {
                    this.gmConnection?.send(data);
                } catch (error) {
                    console.warn('Failed to send data to GM.', error);
                    if (this.gmConnection && !this.gmConnection.open) {
                        this.gmConnection = null;
                    }
                } finally {
                    if (this.gmConnection && typeof this.gmConnection.off === 'function') {
                        this.gmConnection.off('open', sendToGm);
                    }
                }
            };

            if (this.gmConnection.open) {
                sendToGm();
            } else {
                this.gmConnection.on('open', sendToGm);
            }
        }
    }

    private handleNetworkData(data: BroadcastMessage, sourcePeerId?: string): void {
        if (this.isGMView) {
            switch (data.type) {
                case 'name_update':
                    this.playerNames[data.playerId] = data.name;
                    this.updateLogEntriesForPlayer(data.playerId, data.name);
                    return;
                case 'initiate':
                    if (!this.markMessageProcessed(`${data.id}-initiate`)) return;
                    this.broadcast(data, { excludePeerId: sourcePeerId });
                    return;
                case 'clear':
                    if (!this.markMessageProcessed(`${data.id}-clear`)) return;
                    this.removeLogEntriesForPlayer(data.playerId);
                    this.broadcast(data, { excludePeerId: sourcePeerId });
                    return;
                case 'result':
                    if (!this.markMessageProcessed(`${data.id}-result`)) return;

                    const results: Record<DieType, { ones: number, sixes: number, count: number }> = {
                        [DieType.Attribute]: { ones: 0, sixes: 0, count: 0 },
                        [DieType.Skill]: { ones: 0, sixes: 0, count: 0 },
                        [DieType.Bonus]: { ones: 0, sixes: 0, count: 0 },
                    };
                    data.diceStates.forEach(state => {
                        results[state.type].count++;
                        if (state.result === 1) results[state.type].ones++;
                        if (state.result === 6) results[state.type].sixes++;
                    });
                    this.updateRollLog(results, data.playerId, data.isReroll);
                    return;
            }
            return;
        }

        switch (data.type) {
            case 'initiate':
                if (!this.markMessageProcessed(`${data.id}-initiate`)) return;
                this.executeRoll(data);
                return;
            case 'clear':
                if (!this.markMessageProcessed(`${data.id}-clear`)) return;
                this.clearPlayerDice(data.playerId);
                if (data.playerId === this.playerId) {
                    this.clearResults();
                    this.rerollUsed = false;
                    this.rerollButton.style.display = 'inline-block';
                }
                return;
            case 'result':
                if (data.playerId !== this.playerId) return;
                if (!this.markMessageProcessed(`${data.id}-result`)) return;
                this.clearResults();
                const statesByType: Record<DieType, { ones: number, sixes: number, count: number }> = {
                    [DieType.Attribute]: { ones: 0, sixes: 0, count: 0 },
                    [DieType.Skill]: { ones: 0, sixes: 0, count: 0 },
                    [DieType.Bonus]: { ones: 0, sixes: 0, count: 0 },
                };
                data.diceStates.forEach(state => {
                    const bucket = statesByType[state.type];
                    bucket.count++;
                    if (state.result === 1) bucket.ones++;
                    if (state.result === 6) bucket.sixes++;
                });
                this.attributeResults.innerHTML = `<span class="crit">Erfolge (6er): ${statesByType[DieType.Attribute].sixes}</span>${(statesByType[DieType.Attribute].ones > 0 ? `<span class="fail">Patzer (1er): ${statesByType[DieType.Attribute].ones}</span>` : '')}`;
                this.skillResults.innerHTML = `<span class="crit">Erfolge (6er): ${statesByType[DieType.Skill].sixes}</span>`;
                this.bonusResults.innerHTML = `<span class="crit">Erfolge (6er): ${statesByType[DieType.Bonus].sixes}</span>${(statesByType[DieType.Bonus].ones > 0 ? `<span class="fail">Patzer (1er): ${statesByType[DieType.Bonus].ones}</span>` : '')}`;
                return;
        }
    }

    private updatePlayAreaSize(): void {
        const fov = this.camera.fov * (Math.PI / 180);
        const camHeight = this.camera.position.y;
        this.playArea.height = 2 * Math.tan(fov / 2) * camHeight;
        this.playArea.width = this.playArea.height * this.camera.aspect;
    }

    private createWalls(): void {
        this.wallBodies.forEach(body => this.physicsWorld.removeBody(body));
        this.wallBodies = [];
        const buffer = DIE_SIZE; 
        const xBoundary = this.playArea.width / 2 - buffer;
        const zBoundary = this.playArea.height / 2 - buffer;
        const wallConfigs = [
            { quaternion: new CANNON.Quaternion().setFromEuler(0, -Math.PI / 2, 0), position: new CANNON.Vec3(xBoundary, 0, 0) },
            { quaternion: new CANNON.Quaternion().setFromEuler(0, Math.PI / 2, 0), position: new CANNON.Vec3(-xBoundary, 0, 0) },
            { quaternion: new CANNON.Quaternion().setFromEuler(0, Math.PI, 0), position: new CANNON.Vec3(0, 0, zBoundary) },
            { quaternion: new CANNON.Quaternion().setFromEuler(0, 0, 0), position: new CANNON.Vec3(0, 0, -zBoundary) }
        ];
        wallConfigs.forEach(config => {
            const wallBody = new CANNON.Body({ type: CANNON.Body.STATIC, shape: new CANNON.Plane(), material: this.groundMaterial, position: config.position, quaternion: config.quaternion });
            this.physicsWorld.addBody(wallBody);
            this.wallBodies.push(wallBody);
        });
    }

    private initScene(): void {
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
        this.camera.position.set(0, 12, 0.01);
        this.camera.lookAt(0, 0, 0);
        this.updatePlayAreaSize();
        const canvas = document.getElementById('bg') as HTMLCanvasElement;
        this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.shadowMap.enabled = true;
        const ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
        this.scene.add(ambientLight);
        const directionalLight = new THREE.DirectionalLight(0xffffff, 1.8);
        directionalLight.position.set(5, 10, 7.5);
        directionalLight.castShadow = true;
        directionalLight.shadow.mapSize.width = 2048;
        directionalLight.shadow.mapSize.height = 2048;
        this.scene.add(directionalLight);
    }

    private initPhysics(): void {
        this.physicsWorld = new CANNON.World({ gravity: new CANNON.Vec3(0, GRAVITY, 0) });
        this.groundMaterial = new CANNON.Material('groundMaterial');
        this.diceMaterial = new CANNON.Material('diceMaterial');
        const contactMaterial = new CANNON.ContactMaterial(this.groundMaterial, this.diceMaterial, { friction: 0.1, restitution: 0.5 });
        this.physicsWorld.addContactMaterial(contactMaterial);
        const groundBody = new CANNON.Body({ type: CANNON.Body.STATIC, shape: new CANNON.Plane(), material: this.groundMaterial });
        groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
        this.physicsWorld.addBody(groundBody);
        this.createWalls();
    }

    private initUI(): void {
        this.launcherContainer = document.getElementById('launcher') as HTMLElement;
        const joinGameButton = document.getElementById('join-game-button') as HTMLButtonElement;
        const playerNameInput = document.getElementById('player-name-input') as HTMLInputElement;

        joinGameButton.addEventListener('click', () => {
            let playerName = playerNameInput.value.trim();
            if (!playerName) {
                playerName = `Anonymous-${Math.floor(Math.random() * 1000)}`;
            }
            const playerId = 'player' + Date.now();
            const url = `${window.location.pathname}?session=${this.sessionId}&name=${encodeURIComponent(playerName)}#${playerId}`;
            window.open(url, `_blank`);
        });

        document.getElementById('gm-btn')?.addEventListener('click', () => {
            const url = `${window.location.pathname}?session=${this.sessionId}#gm-view`;
            window.open(url, '_blank');
        });

        const sessionUrlInput = document.getElementById('session-url-input') as HTMLInputElement;
        const copyUrlButton = document.getElementById('copy-url-button') as HTMLButtonElement;
        if (sessionUrlInput && copyUrlButton) {
            sessionUrlInput.value = `${window.location.origin}${window.location.pathname}?session=${this.sessionId}`;
            copyUrlButton.addEventListener('click', () => {
                navigator.clipboard.writeText(sessionUrlInput.value).then(() => {
                    copyUrlButton.textContent = 'Copied!';
                    setTimeout(() => { copyUrlButton.textContent = 'Copy'; }, 2000);
                });
            });
        }

        this.uiContainer = document.getElementById('ui-container') as HTMLElement;
        this.mainControls = document.getElementById('main-controls') as HTMLElement;
        this.collapsedUI = document.getElementById('collapsed-ui') as HTMLElement;
        this.hideUIButton = document.getElementById('hide-ui-button') as HTMLButtonElement;
        this.showUIButton = document.getElementById('show-ui-button') as HTMLButtonElement;
        this.attributeInput = document.getElementById('attribute-dice') as HTMLInputElement;
        this.skillInput = document.getElementById('skill-dice') as HTMLInputElement;
        this.bonusInput = document.getElementById('bonus-dice') as HTMLInputElement;
        this.attributeResults = document.getElementById('attribute-results') as HTMLElement;
        this.skillResults = document.getElementById('skill-results') as HTMLElement;
        this.bonusResults = document.getElementById('bonus-results') as HTMLElement;
        this.rollButton = document.getElementById('roll-button') as HTMLButtonElement;
        this.rerollButton = document.getElementById('reroll-button') as HTMLButtonElement;
        this.rollLogContainer = document.getElementById('roll-log-container') as HTMLElement;
        
        // Name Edit UI elements
        const nameDisplayContainer = document.getElementById('player-name-display-container') as HTMLElement;
        const nameInputContainer = document.getElementById('player-name-input-container') as HTMLElement;
        const editNameButton = document.getElementById('edit-name-button') as HTMLButtonElement;
        const saveNameButton = document.getElementById('save-name-button') as HTMLButtonElement;
        const nameDisplaySpan = document.getElementById('player-name-display') as HTMLSpanElement;
        const nameEditInput = document.getElementById('player-name-edit-input') as HTMLInputElement;

        editNameButton.addEventListener('click', () => {
            nameDisplayContainer.style.display = 'none';
            nameInputContainer.style.display = 'flex';
            nameEditInput.value = this.playerName || '';
            nameEditInput.focus();
        });

        saveNameButton.addEventListener('click', () => {
            const newName = nameEditInput.value.trim();
            if (newName && newName !== this.playerName) {
                this.playerName = newName;
                nameDisplaySpan.textContent = this.playerName;
                this.sendNameUpdate();
            }
            nameDisplayContainer.style.display = 'flex';
            nameInputContainer.style.display = 'none';
        });


        this.rollButton.addEventListener('click', () => this.initiateRoll(false));
        this.rerollButton.addEventListener('click', this.rerollDice.bind(this));
        document.getElementById('clear-button')?.addEventListener('click', () => this.clearAll(true));
        this.hideUIButton.addEventListener('click', () => this.toggleUIVisibility(false));
        this.showUIButton.addEventListener('click', () => this.toggleUIVisibility(true));

        const handleInput = this.updateRollButtonState.bind(this);
        this.attributeInput.addEventListener('input', handleInput);
        this.skillInput.addEventListener('input', handleInput);
        this.bonusInput.addEventListener('input', handleInput);
        this.updateRollButtonState();
    }
    
    private sendNameUpdate(): void {
        if (!this.playerId || !this.playerName) return;
        const payload: PlayerNameUpdate = {
            type: 'name_update',
            playerId: this.playerId,
            name: this.playerName,
        };
        this.broadcast(payload);
    }

    private updateRollButtonState(): void {
        const attributeCount = parseInt(this.attributeInput.value, 10) || 0;
        const skillCount = parseInt(this.skillInput.value, 10) || 0;
        const bonusCount = parseInt(this.bonusInput.value, 10) || 0;
        const totalDice = attributeCount + skillCount + bonusCount;
        this.rollButton.disabled = totalDice === 0;
    }

    private toggleUIVisibility(show: boolean): void {
        this.isUIVisible = show;
        this.mainControls.classList.toggle('hidden', !show);
        this.collapsedUI.classList.toggle('visible', !show);
    }
    
    private getDieConfig(type: DieType): DieConfig {
        return BASE_DICE_CONFIG[type];
    }

    private createDieTexture(value: number, config: DieConfig): THREE.CanvasTexture {
        const cacheKey = `${config.type}-${value}`;
        const cachedTexture = this.dieTextureCache.get(cacheKey);
        if (cachedTexture) {
            return cachedTexture;
        }

        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d')!;
        canvas.width = 128;
        canvas.height = 128;
        context.fillStyle = `#${config.color.toString(16).padStart(6, '0')}`;
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillStyle = config.textColor;

        const isExplosion = value === 1 && (config.type === DieType.Attribute || config.type === DieType.Bonus);
        const isCrit = value === 6;

        if (isExplosion) {
            context.font = 'bold 96px Orbitron, sans-serif';
            context.fillText('💥', canvas.width / 2, canvas.height / 2 + 8);
        } else if (isCrit) {
            context.beginPath();
            context.arc(canvas.width / 2, canvas.height / 2, 40, 0, 2 * Math.PI);
            context.fill();
            context.fillStyle = `#${config.color.toString(16).padStart(6, '0')}`;
            context.beginPath();
            context.arc(canvas.width / 2, canvas.height / 2, 10, 0, 2 * Math.PI);
            context.fill();
        } else {
            context.font = 'bold 80px Orbitron, sans-serif';
            context.fillText(String(value), canvas.width / 2, canvas.height / 2);
        }
        const texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;
        this.dieTextureCache.set(cacheKey, texture);
        return texture;
    }
    
    private createDie(type: DieType, playerId: string, addToPhysics: boolean = true): DieObject {
        const config = this.getDieConfig(type);
        const materials = [
            new THREE.MeshStandardMaterial({ map: this.createDieTexture(1, config) }),
            new THREE.MeshStandardMaterial({ map: this.createDieTexture(6, config) }),
            new THREE.MeshStandardMaterial({ map: this.createDieTexture(2, config) }),
            new THREE.MeshStandardMaterial({ map: this.createDieTexture(5, config) }),
            new THREE.MeshStandardMaterial({ map: this.createDieTexture(3, config) }),
            new THREE.MeshStandardMaterial({ map: this.createDieTexture(4, config) }),
        ];
        
        const geometry = new THREE.BoxGeometry(DIE_SIZE, DIE_SIZE, DIE_SIZE);
        const mesh = new THREE.Mesh(geometry, materials);
        mesh.castShadow = true;
        this.scene.add(mesh);

        const body = new CANNON.Body({ mass: 1, shape: new CANNON.Box(new CANNON.Vec3(DIE_SIZE / 2, DIE_SIZE / 2, DIE_SIZE / 2)), material: this.diceMaterial });
        if (addToPhysics) {
            this.physicsWorld.addBody(body);
        }

        return { mesh, body, type, settled: false, result: 0, playerId };
    }

    private clearDice(diceToKeep: DieObject[] = []): void {
        const diceToRemove = this.dice.filter(d => !diceToKeep.includes(d));
        diceToRemove.forEach(d => {
            this.scene.remove(d.mesh);
            d.mesh.geometry.dispose();
            (d.mesh.material as THREE.Material[]).forEach(m => m.dispose());
            if (this.physicsWorld.bodies.includes(d.body)) {
                this.physicsWorld.removeBody(d.body);
            }
        });
        this.dice = diceToKeep;
    }

    private clearPlayerDice(playerId: string): void {
        const diceToKeep = this.dice.filter(d => d.playerId !== playerId);
        this.clearDice(diceToKeep);
        this.animatingDice = this.animatingDice.filter(ad => ad.die.playerId !== playerId);
    }
    
    private clearAll(broadcastClear: boolean = false): void {
        if (broadcastClear && this.playerId) {
            const clearId = Date.now().toString() + Math.random();
            const payload: ClearAction = {
                type: 'clear',
                id: clearId,
                playerId: this.playerId,
            };
            this.markMessageProcessed(`${clearId}-clear`);
            this.broadcast(payload);
            this.clearPlayerDice(this.playerId); // Clear our own dice immediately
        }

        this.clearDice();
        this.clearResults();
        this.rerollUsed = false;
        this.rerollButton.style.display = 'inline-block';
        this.animatingDice = [];
        this.attributeInput.value = '0';
        this.skillInput.value = '0';
        this.bonusInput.value = '0';
        this.updateRollButtonState();
        if (this.isGMView) {
            this.rollLogContainer.innerHTML = '';
        }
    }

    private initiateRoll(isReroll: boolean, diceToRoll?: {type: DieType, count: number}[], existingDiceToKeep?: DieObject[]): void {
        if (!this.playerId) {
            console.warn("Roll initiated from non-player view. Ignoring.");
            return;
        }
    
        this.currentRollIsNew = !isReroll;
    
        const rollId = Date.now().toString() + Math.random();
    
        const diceList = diceToRoll || [
            { type: DieType.Attribute, count: parseInt(this.attributeInput.value, 10) || 0 },
            { type: DieType.Skill, count: parseInt(this.skillInput.value, 10) || 0 },
            { type: DieType.Bonus, count: parseInt(this.bonusInput.value, 10) || 0 },
        ];
    
        const payload: RollInitiation = {
            type: 'initiate',
            id: rollId,
            playerId: this.playerId,
            dice: diceList,
            clearScreen: !isReroll
        };

        this.markMessageProcessed(`${rollId}-initiate`);

        if (existingDiceToKeep) {
            this.clearDice(existingDiceToKeep);
        }
    
        this.executeRoll(payload);
        this.broadcast(payload);
    }

    private executeRoll(rollData: RollInitiation): void {
        if (rollData.clearScreen) { 
            this.clearPlayerDice(rollData.playerId);
    
            this.rerollUsed = false;
             if (this.playerId === rollData.playerId) {
                this.rerollButton.style.display = 'inline-block';
             }
        }

        if (this.isGMView) {
            return;
        }
        
        if (this.playerId === rollData.playerId) {
            this.lastInitiatedRollId = rollData.id;
        }

        if (this.settlingTimeout) clearTimeout(this.settlingTimeout);
        if (this.playerId === rollData.playerId) this.clearResults();

        rollData.dice.forEach(({ type, count }) => {
            for (let i = 0; i < count; i++) {
                const die = this.createDie(type, rollData.playerId);
                const xRange = this.playArea.width / 2 - DIE_SIZE;
                const zRange = this.playArea.height / 2 - DIE_SIZE;
                const startX = (Math.random() - 0.5) * xRange * 1.8;
                const startZ = (Math.random() - 0.5) * zRange * 1.8;
                const startY = Math.random() * 2 + 4; 
                die.body.position.set(startX, startY, startZ);
                die.body.velocity.set(0, 0, 0);
                die.body.quaternion.setFromEuler(Math.random()*Math.PI*2, Math.random()*Math.PI*2, Math.random()*Math.PI*2);
                die.body.angularVelocity.set((Math.random()-0.5)*20, (Math.random()-0.5)*20, (Math.random()-0.5)*20);
                this.dice.push(die);
            }
        });
        this.settlingTimeout = window.setTimeout(this.checkIfSettled.bind(this), 2000);
    }
    
    private rerollDice(): void {
        if (this.rerollUsed || this.dice.length === 0 || !this.playerId) return;
        
        const diceToKeep: DieObject[] = [];
        const diceToRerollMap = new Map<DieType, number>();

        this.dice.forEach(die => {
            if (die.playerId !== this.playerId) {
                diceToKeep.push(die);
                return;
            }

            if (!die.settled) return;
            let keep = false;
            if (die.type === DieType.Attribute || die.type === DieType.Bonus) {
                if (die.result === 1 || die.result === 6) keep = true;
            } else if (die.type === DieType.Skill) {
                if (die.result === 6) keep = true;
            }
            if (keep) {
                diceToKeep.push(die);
            } else {
                diceToRerollMap.set(die.type, (diceToRerollMap.get(die.type) || 0) + 1);
            }
        });
        
        const diceToReroll = Array.from(diceToRerollMap.entries()).map(([type, count]) => ({type, count}));
        if (diceToReroll.length === 0) return;

        this.rerollUsed = true;
        this.rerollButton.style.display = 'none';
        
        this.initiateRoll(true, diceToReroll, diceToKeep);
    }

    private checkIfSettled(): void {
        const allSettled = this.dice.every(d => {
            if (d.body.type === CANNON.Body.STATIC || !this.physicsWorld.bodies.includes(d.body)) return true;
            const vel = d.body.velocity.length();
            const angVel = d.body.angularVelocity.length();
            return vel < SETTLE_THRESHOLD && angVel < SETTLE_THRESHOLD;
        });
        if (allSettled) {
            this.processResults();
        } else {
            this.settlingTimeout = window.setTimeout(this.checkIfSettled.bind(this), 500);
        }
    }

    private processResults(): void {
        const diceJustSettled: DieObject[] = [];
        this.dice.forEach(die => {
            if (die.settled || !this.physicsWorld.bodies.includes(die.body)) return;
            
            die.settled = true; 
            diceJustSettled.push(die);
        });

        if(diceJustSettled.length === 0) return;
        
        const uniquePlayerIds = [...new Set(diceJustSettled.map(d => d.playerId))];

        uniquePlayerIds.forEach(playerId => {
            const playerDice = this.dice.filter(d => d.playerId === playerId);
            if(playerDice.length === 0) return;

            if (this.playerId === playerId) {
                playerDice.forEach(die => {
                    if (die.result > 0) return;
                    const faceNormals = [ new THREE.Vector3(1,0,0), new THREE.Vector3(-1,0,0), new THREE.Vector3(0,1,0), new THREE.Vector3(0,-1,0), new THREE.Vector3(0,0,1), new THREE.Vector3(0,0,-1) ];
                    const faceValues = [1, 6, 2, 5, 3, 4];
                    let maxDot = -Infinity, topFaceIndex = -1;
                    for (let i = 0; i < faceNormals.length; i++) {
                        const worldNormal = faceNormals[i].clone().applyQuaternion(die.mesh.quaternion);
                        const dot = worldNormal.dot(new THREE.Vector3(0, 1, 0));
                        if (dot > maxDot) { maxDot = dot; topFaceIndex = i; }
                    }
                    die.result = faceValues[topFaceIndex];
                    this.updateDieColor(die, die.result);
                });
                
                if (!this.lastInitiatedRollId) {
                    console.error("Cannot broadcast results: Missing roll initiation ID.");
                    return;
                }
                
                const playerDiceStates = playerDice
                    .filter(d => d.result > 0)
                    .map(d => ({ type: d.type, result: d.result }));

                const broadcastData: RollResult = {
                    type: 'result',
                    id: this.lastInitiatedRollId,
                    playerId: this.playerId,
                    diceStates: playerDiceStates,
                    isReroll: !this.currentRollIsNew
                };
                
                this.broadcast(broadcastData);
                this.updateResultsDisplay();
                this.arrangeSpecialDice(playerId);
                
                this.lastInitiatedRollId = null;
            }
        });
    }
    
    private arrangeSpecialDice(playerIdOfRoll: string): void {
        if (this.isGMView) {
            return;
        }

        const alreadyArrangedDice = this.dice.filter(d => d.body.type === CANNON.Body.STATIC);
        const newSpecialDice: DieObject[] = [];
        this.dice.forEach(die => {
            if (die.playerId === playerIdOfRoll && die.body.type !== CANNON.Body.STATIC) {
                let isSpecial = false;
                if (die.result > 0) {
                    if (die.type === DieType.Attribute || die.type === DieType.Bonus) { if (die.result === 1 || die.result === 6) isSpecial = true; } 
                    else if (die.type === DieType.Skill) { if (die.result === 6) isSpecial = true; }
                }
                if (isSpecial) newSpecialDice.push(die);
            }
        });
        if (newSpecialDice.length === 0) return;
        newSpecialDice.sort((a, b) => a.type.localeCompare(b.type) || b.result - a.result);
        
        const yPos = DIE_SIZE / 2 + 0.05;
        const startX = this.playArea.width / 2 - DIE_SIZE * 1.5;
        const startZ = -this.playArea.height / 2 + DIE_SIZE * 1.5;
        const maxInRow = Math.max(1, Math.floor((this.playArea.width - DIE_SIZE * 3) / (DIE_SIZE * 1.5)));
        let nextIndex = alreadyArrangedDice.filter(d => d.playerId === playerIdOfRoll).length;

        newSpecialDice.forEach(die => {
            if (die.result === 1 && (die.type === DieType.Attribute || die.type === DieType.Bonus)) {
                (die.mesh.material as THREE.MeshStandardMaterial[]).forEach(m => m.color.set(RESULT_COLORS.patzerArrange));
            }
            const row = Math.floor(nextIndex / maxInRow), col = nextIndex % maxInRow;
            const targetPos = new THREE.Vector3(startX - col * (DIE_SIZE * 1.5), yPos, startZ + row * (DIE_SIZE * 1.5));
            const up = new THREE.Vector3(0, 1, 0);
            const faceNormals = [ new THREE.Vector3(1,0,0), new THREE.Vector3(-1,0,0), new THREE.Vector3(0,1,0), new THREE.Vector3(0,-1,0), new THREE.Vector3(0,0,1), new THREE.Vector3(0,0,-1) ];
            const faceValues = [1, 6, 2, 5, 3, 4];
            const faceIndex = faceValues.indexOf(die.result);
            const targetQuat = new THREE.Quaternion();
            if (faceIndex !== -1) { targetQuat.setFromUnitVectors(faceNormals[faceIndex].clone(), up); }
            
            if (this.physicsWorld.bodies.includes(die.body)) {
                this.physicsWorld.removeBody(die.body);
            }
            die.body = new CANNON.Body({ type: CANNON.Body.STATIC });
            this.animatingDice.push({ die: die, startPos: die.mesh.position.clone(), endPos: targetPos, startQuat: die.mesh.quaternion.clone(), endQuat: targetQuat, progress: 0 });
            nextIndex++;
        });
    }

    private updateDieColor(die: DieObject, result: number) {
        if (result === 6) {
            (die.mesh.material as THREE.MeshStandardMaterial[]).forEach(m => m.color.set(RESULT_COLORS.success));
        }
    }

    private updateResultsDisplay(): void {
        const results: Record<DieType, { ones: number, sixes: number, count: number }> = {
            [DieType.Attribute]: { ones: 0, sixes: 0, count: 0 },
            [DieType.Skill]: { ones: 0, sixes: 0, count: 0 },
            [DieType.Bonus]: { ones: 0, sixes: 0, count: 0 },
        };
        this.dice.forEach(die => {
            if (die.playerId !== this.playerId) return; // Only count our own dice
            results[die.type].count++;
            if (die.result === 1) results[die.type].ones++;
            if (die.result === 6) results[die.type].sixes++;
        });

        const formatResult = (type: DieType, r: { ones: number, sixes: number }) => {
            let oneHtml = '';
            if (type === DieType.Attribute || type === DieType.Bonus) {
                oneHtml = `<span class="fail">Patzer (1er): ${r.ones}</span>`;
            }
            return `<span class="crit">Erfolge (6er): ${r.sixes}</span>${oneHtml}`;
        };
        this.attributeResults.innerHTML = formatResult(DieType.Attribute, results[DieType.Attribute]);
        this.skillResults.innerHTML = formatResult(DieType.Skill, results[DieType.Skill]);
        this.bonusResults.innerHTML = formatResult(DieType.Bonus, results[DieType.Bonus]);
    }
    
    private updateLogEntriesForPlayer(playerId: string, newName: string): void {
        if (!this.isGMView) return;
        const entries = this.rollLogContainer.querySelectorAll(`.roll-log-entry[data-player-id="${playerId}"]`);
        entries.forEach(entry => {
            const nameElement = entry.querySelector('.roll-log-player-name');
            if (nameElement) {
                const isReroll = nameElement.textContent?.includes('(Reroll)');
                nameElement.textContent = `${newName}${isReroll ? ' (Reroll)' : ''}`;
            }
        });
    }

    private removeLogEntriesForPlayer(playerId: string): void {
        if (!this.isGMView) return;
        const entries = this.rollLogContainer.querySelectorAll(`.roll-log-entry[data-player-id="${playerId}"]`);
        entries.forEach(entry => entry.remove());
    }

    private updateRollLog(results: Record<DieType, { ones: number, sixes: number, count: number }>, playerId: string, isReroll: boolean): void {
        const totalSuccesses = results[DieType.Attribute].sixes + results[DieType.Skill].sixes + results[DieType.Bonus].sixes;
        const playerNameRaw = this.playerNames[playerId] || `Spieler ${playerId.replace('player', '')}`;
        const rerollText = isReroll ? ' (Reroll)' : '';
        const playerName = `${playerNameRaw}${rerollText}`;
    
        const details = [
            results[DieType.Attribute].count > 0 ? `${results[DieType.Attribute].count} Attr` : '',
            results[DieType.Skill].count > 0 ? `${results[DieType.Skill].count} Fert` : '',
            results[DieType.Bonus].count > 0 ? `${results[DieType.Bonus].count} Bonus` : ''
        ].filter(Boolean).join(', ');
    
        const successHtml = `<span class="crit">Erfolge: ${totalSuccesses}</span>`;
    
        const patzerComponents: string[] = [];
        if (results[DieType.Attribute].ones > 0) {
            patzerComponents.push(`Attribut: ${results[DieType.Attribute].ones}`);
        }
        if (results[DieType.Bonus].ones > 0) {
            patzerComponents.push(`Bonus: ${results[DieType.Bonus].ones}`);
        }
        
        let patzerHtml = '';
        if (patzerComponents.length > 0) {
            patzerHtml = ` | <span class="fail">Patzer: ${patzerComponents.join(', ')}</span>`;
        }
    
        const entry = document.createElement('div');
        entry.className = 'roll-log-entry';
        entry.dataset.playerId = playerId;
        entry.innerHTML = `
            <div class="roll-log-player-name">${playerName}</div>
            <div class="roll-log-details">${details}</div>
            <div class="roll-log-results">
                ${successHtml}${patzerHtml}
            </div>
        `;
        this.rollLogContainer.prepend(entry);
    }

    private clearResults(): void {
        this.attributeResults.innerHTML = '';
        this.skillResults.innerHTML = '';
        this.bonusResults.innerHTML = '';
    }

    private onWindowResize(): void {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.updatePlayAreaSize();
        this.createWalls();
    }

    private handleRouteChange(): void {
        const hash = window.location.hash;
        const urlParams = new URLSearchParams(window.location.search);

        this.isGMView = false;
        this.playerId = null;
        this.playerName = null;
        document.body.className = '';
        this.processedRolls.clear();

        if (hash.startsWith('#player')) {
            this.playerId = hash.substring(1);
            this.playerName = urlParams.get('name') || `Spieler ${this.playerId.replace('player', '')}`;
            document.body.classList.add('is-player');
            
            const nameDisplaySpan = document.getElementById('player-name-display') as HTMLSpanElement;
            if (nameDisplaySpan) {
                nameDisplaySpan.textContent = this.playerName;
            }

        } else if (hash === '#gm-view') {
            this.isGMView = true;
            document.body.classList.add('is-gm');
        } else {
            document.body.classList.add('is-launcher');
        }
        
        this.initNetworking();
        this.clearAll(false);
    }

    private isDieAnimating(die: DieObject): boolean {
        return this.animatingDice.some(anim => anim.die === die);
    }

    private animate(): void {
        const deltaTime = this.clock.getDelta();
        requestAnimationFrame(this.animate.bind(this));
        
        if (!document.body.classList.contains('is-launcher') && !this.isGMView) {
            const fixedTimeStep = 1 / 60;
            this.physicsWorld.step(fixedTimeStep, deltaTime);
        }

        this.dice.forEach(d => {
            if (d.body.type === CANNON.Body.DYNAMIC && !this.isDieAnimating(d) && this.physicsWorld.bodies.includes(d.body)) {
                d.mesh.position.copy(d.body.position as unknown as THREE.Vector3);
                d.mesh.quaternion.copy(d.body.quaternion as unknown as THREE.Quaternion);
            }
        });

        const stillAnimating: typeof this.animatingDice = [];
        this.animatingDice.forEach(anim => {
            anim.progress += deltaTime / this.animationDuration;
            const easeOutCubic = (x: number): number => 1 - Math.pow(1 - x, 3);
            const easedProgress = easeOutCubic(anim.progress);

            if (anim.progress < 1) {
                anim.die.mesh.position.lerpVectors(anim.startPos, anim.endPos, easedProgress);
                anim.die.mesh.quaternion.copy(anim.startQuat).slerp(anim.endQuat, easedProgress);
                stillAnimating.push(anim);
            } else {
                anim.die.mesh.position.copy(anim.endPos);
                anim.die.mesh.quaternion.copy(anim.endQuat);
            }
        });
        this.animatingDice = stillAnimating;

        this.renderer.render(this.scene, this.camera);
    }
}

new HeliosDiceRoller();