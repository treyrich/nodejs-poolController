/*  nodejs-poolController.  An application to control pool equipment.
Copyright (C) 2016, 2017, 2018, 2019, 2020, 2021, 2022.  
Russell Goldin, tagyoureit.  russ.goldin@gmail.com

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/
import { ConfigMessage } from "./config/ConfigMessage";
import { PumpMessage } from "./config/PumpMessage";
import { VersionMessage } from "./status/VersionMessage";
import { PumpStateMessage } from "./status/PumpStateMessage";
import { EquipmentStateMessage } from "./status/EquipmentStateMessage";
import { HeaterStateMessage } from "./status/HeaterStateMessage";
import { ChlorinatorStateMessage } from "./status/ChlorinatorStateMessage";
import { ChlorinatorMessage } from "./config/ChlorinatorMessage";
import { ExternalMessage } from "./config/ExternalMessage";
import { Timestamp, ControllerType } from "../../Constants";
import { CircuitMessage } from "./config/CircuitMessage";
import { config } from '../../../config/Config';
import { sys } from '../../Equipment';
import { logger } from "../../../logger/Logger";
import { CustomNameMessage } from "./config/CustomNameMessage";
import { ScheduleMessage } from "./config/ScheduleMessage";
import { RemoteMessage } from "./config/RemoteMessage";
import { OptionsMessage } from "./config/OptionsMessage";
import { EquipmentMessage } from "./config/EquipmentMessage";
import { ValveMessage } from "./config/ValveMessage";
import { state } from "../../State";
import { HeaterMessage } from "./config/HeaterMessage";
import { CircuitGroupMessage } from "./config/CircuitGroupMessage";
import { IntellichemMessage } from "./config/IntellichemMessage";
import { TouchScheduleCommands } from "controller/boards/EasyTouchBoard";
import { IntelliValveStateMessage } from "./status/IntelliValveStateMessage";
import { IntelliChemStateMessage } from "./status/IntelliChemStateMessage";
import { OutboundMessageError } from "../../Errors";
import { conn } from "../Comms"
import extend = require("extend");
import { MessagesMock } from "../../../anslq25/MessagesMock";

export enum Direction {
    In = 'in',
    Out = 'out'
}
export enum Protocol {
    Unknown = 'unknown',
    Broadcast = 'broadcast',
    Pump = 'pump',
    Chlorinator = 'chlorinator',
    IntelliChem = 'intellichem',
    IntelliValve = 'intellivalve',
    Heater = 'heater',
    AquaLink = 'aqualink',
    Hayward = 'hayward',
    Unidentified = 'unidentified'
}
export class Message {
    constructor() { }

    // Internal Storage
    protected _complete: boolean = false;
    public static headerSubByte: number = 33;
    public static pluginAddress: number = config.getSection('controller', { address: 33 }).address;
    private _id: number = -1;
    // Fields
    private static _messageId: number = 0;
    public static get nextMessageId(): number { 
        let i = this._messageId < 80000 ? ++this._messageId : this._messageId = 0;
        //logger.debug(`Assigning message id ${i}`)
        return i; }
    public portId = 0; // This will be the target or source port for the message.  If this is from or to an Aux RS485 port the value will be > 0.
    public timestamp: Date = new Date();
    public direction: Direction = Direction.In;
    public protocol: Protocol = Protocol.Unknown;
    public padding: number[] = [];
    public preamble: number[] = [];
    public header: number[] = [];
    public payload: number[] = [];
    public term: number[] = [];
    public packetCount: number = 0;
    public get id(): number { return this._id; }
    public set id(val: number) { this._id = val; }
    public isValid: boolean = true;
    public scope: string;
    public isClone: boolean;
    // Properties
    public get isComplete(): boolean { return this._complete; }
    public get sub(): number { return this.header.length > 1 ? this.header[1] : -1; }
    public get dest(): number {
        if (this.header.length > 2) {
            if (this.protocol === Protocol.Chlorinator || this.protocol === Protocol.AquaLink) {
                return this.header.length > 2 ? (this.header[2] >= 80 ? this.header[2] : 0) : -1;
            }
            else if (this.protocol === Protocol.Hayward) {
                //            src   act   dest             
                //0x10, 0x02, 0x00, 0x0C, 0x00, 0x00, 0x2D, 0x02, 0x36, 0x00, 0x83, 0x10, 0x03 -- Response from pump
                return this.header.length > 4 ? this.header[2] : -1;
            }
            else return this.header.length > 2 ? this.header[2] : -1;
        }
        else return -1;
    }
    public get source(): number {
        if (this.protocol === Protocol.Chlorinator) {
            return this.header.length > 2 ? (this.header[2] >= 80 ? 0 : this.header[2]) : -1;
            // have to assume incoming packets with header[2] >= 80 (sent to a chlorinator)
            // are from controller (0);
            // likewise, if the destination is 0 (controller) we
            // have to assume it was sent from the 1st chlorinator (1)
            // until we learn otherwise.  
        }
        else if (this.protocol === Protocol.AquaLink) {
            // Once we decode the devices we will be able to tell where it came from based upon the commands.
            return 0;
        }
        else if (this.protocol === Protocol.Hayward) {
            //            src   act   dest             
            //0x10, 0x02, 0x00, 0x0C, 0x00, 0x00, 0x2D, 0x02, 0x36, 0x00, 0x83, 0x10, 0x03 -- Response from pump
            //0x10, 0x02, 0x0C, 0x01, 0x02, 0x2D, 0x00, 0x4E, 0x10, 0x03 -- Command to AUX2 Pump
            return this.header.length > 4 ? this.header[4] : -1;
        }
        if (this.header.length > 3) return this.header[3];
        else return -1;
    }
    public get action(): number {
        // The action byte is actually the 4th byte in the header the destination address is the 5th byte.
        if (this.protocol === Protocol.Chlorinator ||
            this.protocol === Protocol.AquaLink) return this.header.length > 3 ? this.header[3] : -1;
        else if (this.protocol === Protocol.Hayward) {
            //            src   act   dest             
            //0x10, 0x02, 0x00, 0x0C, 0x00, 0x00, 0x2D, 0x02, 0x36, 0x00, 0x83, 0x10, 0x03 -- Response from pump
            //0x10, 0x02, 0x0C, 0x01, 0x02, 0x2D, 0x00, 0x4E, 0x10, 0x03 -- Command to AUX2 Pump
            return this.header.length > 3 ? this.header[3] || this.header[2] : -1;
        }
        if (this.header.length > 4) return this.header[4];
        else return -1;
    }
    public get datalen(): number { return this.protocol === Protocol.Chlorinator || this.protocol === Protocol.AquaLink || this.protocol === Protocol.Hayward ? this.payload.length : this.header.length > 5 ? this.header[5] : -1; }
    public get chkHi(): number { return this.protocol === Protocol.Chlorinator || this.protocol === Protocol.AquaLink ? 0 : this.term.length > 0 ? this.term[0] : -1; }
    public get chkLo(): number { return this.protocol === Protocol.Chlorinator || this.protocol === Protocol.AquaLink ? this.term[0] : this.term[1]; }
    public get checksum(): number {
        var sum = 0;
        for (let i = 0; i < this.header.length; i++) sum += this.header[i];
        for (let i = 0; i < this.payload.length; i++) sum += this.payload[i];
        return sum;
    }

    // Methods
    public toPacket(): number[] {
        const pkt = [];
        pkt.push(...this.padding);
        pkt.push(...this.preamble);
        pkt.push(...this.header);
        pkt.push(...this.payload);
        pkt.push(...this.term);
        return pkt;
    }
    public toShortPacket(): number[] {
        const pkt = [];
        pkt.push(...this.header);
        pkt.push(...this.payload);
        pkt.push(...this.term);
        return pkt;
    }
    public toLog(): string {
        return `{"port":${this.portId},"id":${this.id},"valid":${this.isValid},"dir":"${this.direction}","proto":"${this.protocol}","pkt":[${JSON.stringify(this.padding)},${JSON.stringify(this.preamble)}, ${JSON.stringify(this.header)}, ${JSON.stringify(this.payload)},${JSON.stringify(this.term)}],"ts":"${Timestamp.toISOLocal(this.timestamp)}"}`;
    }
    public static convertOutboundToInbound(out: Outbound): Inbound {
        let inbound = new Inbound();
        inbound.portId = out.portId;
        // inbound.id = Message.nextMessageId;
        inbound.protocol = out.protocol;
        inbound.scope = out.scope;
        inbound.preamble = out.preamble;
        inbound.padding = out.padding;
        inbound.header = out.header;
        inbound.payload = [...out.payload];
        inbound.term = out.term;
        inbound.portId = out.portId;
        return inbound;
    }
    public static convertInboundToOutbound(inbound: Inbound): Outbound {
        let out = new Outbound(
            inbound.protocol,
            inbound.source,
            inbound.dest,
            inbound.action,
            inbound.payload,
        );
        out.scope = inbound.scope;
        out.preamble = inbound.preamble;
        out.padding = inbound.padding;
        out.header = inbound.header;
        out.term = inbound.term;
        out.portId = inbound.portId;
        return out;
    }
    public clone(): Inbound | Outbound {
        let msg;
        if (this instanceof Inbound) {
            msg = new Inbound();
            msg.id = Message.nextMessageId;
            msg.scope = this.scope;
            msg.preamble = this.preamble;
            msg.padding = this.padding;
            msg.payload = [...this.payload];
            msg.header = this.header;
            msg.term = this.term;
            msg.portId = this.portId;
        }
        else {
            msg = new Outbound(
                this.protocol, this.source, this.dest, this.action, [...this.payload], 
            );
            msg.portId = this.portId;
            msg.scope = this.scope;
        }
        return msg;
    }
}
export class Inbound extends Message {
    // /usr/bin/socat TCP-LISTEN:9801,fork,reuseaddr FILE:/dev/ttyUSB0,b9600,raw
    // /usr/bin/socat TCP-LISTEN:9801,fork,reuseaddr FILE:/dev/ttyUSB0,b9600,cs8,cstopb=1,parenb=0,raw
    // /usr/bin / socat TCP - LISTEN: 9801,fork,reuseaddr FILE:/dev/ttyUSB0, b9600, cs8, cstopb = 1, parenb = 0, raw
    constructor() {
        super();
        this.direction = Direction.In;
    }
    // Factory
    public static replay(obj?: any) {
        let inbound = new Inbound();
        inbound.readHeader(obj.header, 0);
        inbound.readPayload(obj.payload, 0);
        inbound.readChecksum(obj.term, 0);
        inbound.process();
    }
    public responseFor: number[] = [];
    public isProcessed: boolean = false;
    public collisions: number = 0;
    public rewinds: number = 0;
    // Private methods
    private isValidChecksum(): boolean {
        if (this.protocol === Protocol.Chlorinator || this.protocol === Protocol.AquaLink) return this.checksum % 256 === this.chkLo;
        return (this.chkHi * 256) + this.chkLo === this.checksum;
    }
    public toLog() {
        if (this.responseFor.length > 0)
            return `{"port":${this.portId || 0},"id":${this.id},"valid":${this.isValid},"dir":"${this.direction}","proto":"${this.protocol}","for":${JSON.stringify(this.responseFor)},"pkt":[${JSON.stringify(this.padding)},${JSON.stringify(this.preamble)},${JSON.stringify(this.header)},${JSON.stringify(this.payload)},${JSON.stringify(this.term)}],"ts": "${Timestamp.toISOLocal(this.timestamp)}"}`;
        return `{"port":${this.portId || 0},"id":${this.id},"valid":${this.isValid},"dir":"${this.direction}","proto":"${this.protocol}","pkt":[${JSON.stringify(this.padding)},${JSON.stringify(this.preamble)},${JSON.stringify(this.header)},${JSON.stringify(this.payload)},${JSON.stringify(this.term)}],"ts": "${Timestamp.toISOLocal(this.timestamp)}"}`;
    }
    private testChlorHeader(bytes: number[], ndx: number): boolean {
        // if packets have 16,2 (eg status=16,2,29) in them and they come as partial packets, they would have
        // prev been detected as chlor packets;
        // valid chlor packets should have 16,2,0 or 16,2,[80-96];
        // this should reduce the number of false chlor packets
        // For any of these 16,2 type headers we need at least 5 bytes to determine the routing.
        //63,15,16,2,29,9,36,0,0,0,0,0,16,0,32,0,0,2,0,75,75,32,241,80,85,24,241,16,16,48,245,69,45,100,186,16,2,80,17,0,115,16,3
        if (bytes.length > ndx + 4) {
            if (bytes[ndx] === 16 && bytes[ndx + 1] === 2) {
                let dst = bytes[ndx + 2];
                let act = bytes[ndx + 3];
                // For now the dst byte will always be 0 or 80.
                if (![0, 16, 80, 81, 82, 83].includes(dst)) {
                    //logger.info(`Sensed chlorinator header but the dst byte is ${dst}`);
                    return false;
                }
                else if (dst === 0 && [1, 18, 3].includes(act))
                    return true;
                else if (![0, 17, 19, 20, 21, 22].includes(act)) {
                    //logger.info(`Sensed out chlorinator header but the dst byte is ${dst} ${act} ${JSON.stringify(bytes)}`);
                    return false;
                }
                return true;
            }
        }
        return false;
    }
    private testAquaLinkHeader(bytes: number[], ndx: number): boolean {
        if (bytes.length > ndx + 4 && sys.controllerType === 'aqualink') {
            if (bytes[ndx] === 16 && bytes[ndx + 1] === 2) {
                return true;
            }
        }
        return false;
    }
    private testHaywardHeader(bytes: number[], ndx: number): boolean {
        //0x10, 0x02, 0x0C, 0x01, 0x00, 0x2D, 0x00, 0x4C, 0x10, 0x03 -- Command to pump
        //[16,2,12,1,0]
        //0x10, 0x02, 0x0C, 0x01, 0x00, 0x2D, 0x00, 0x4C, 0x10, 0x03 -- Command to Filter Pump
        //[16,2,12,1,0]
        //0x10, 0x02, 0x0C, 0x01, 0x02, 0x2D, 0x00, 0x4E, 0x10, 0x03 -- Command to AUX2 Pump
        //[16,2,12,1,2]
        //            src   act   dest             
        //0x10, 0x02, 0x00, 0x0C, 0x00, 0x00, 0x2D, 0x02, 0x36, 0x00, 0x83, 0x10, 0x03 -- Response from pump
        //[16,2,0,12,0] --> Response
        //[16,2,0,12,0]
        if (bytes.length > ndx + 4) {
            if (sys.controllerType === 'aqualink') return false;
            if (bytes[ndx] === 16 && bytes[ndx + 1] === 2) {
                let dst = bytes[ndx + 3];
                let src = bytes[ndx + 2];
                if (dst === 12 || src === 12) return true;
            }
        }
        return false;
    }
    private testBroadcastHeader(bytes: number[], ndx: number): boolean {
        // We are looking for [255,0,255,165]
        if (bytes.length > ndx + 3) {
            if (bytes[ndx] === 255 && bytes[ndx + 1] === 0 && bytes[ndx + 2] === 255 && bytes[ndx + 3] === 165) return true;
            return false;
        }
        //return ndx < bytes.length - 3 && bytes[ndx] === 255 && bytes[ndx + 1] === 0 && bytes[ndx + 2] === 255 && bytes[ndx + 3] === 165;
        return false;
    }
    private testUnidentifiedHeader(bytes: number[], ndx: number): boolean {
        if (bytes.length > ndx + 3) {
            if (bytes[ndx] === 255 && bytes[ndx + 1] === 0 && bytes[ndx + 2] === 255 && bytes[ndx + 3] !== 165) return true;
            return false;
        }
        //return ndx < bytes.length - 3 && bytes[ndx] === 255 && bytes[ndx + 1] === 0 && bytes[ndx + 2] === 255 && bytes[ndx + 3] !== 165;
        return false;
    }
    private testChlorTerm(bytes: number[], ndx: number): boolean { return ndx + 2 < bytes.length && bytes[ndx + 1] === 16 && bytes[ndx + 2] === 3; }
    private testAquaLinkTerm(bytes: number[], ndx: number): boolean { return ndx + 2 < bytes.length && bytes[ndx + 1] === 16 && bytes[ndx + 2] === 3; }
    private testHaywardTerm(bytes: number[], ndx: number): boolean { return ndx + 3 < bytes.length && bytes[ndx + 2] === 16 && bytes[ndx + 3] === 3; }
    private pushBytes(target: number[], bytes: number[], ndx: number, length: number): number {
        let end = ndx + length;
        while (ndx < bytes.length && ndx < end)
            target.push(bytes[ndx++]);
        return ndx;
    }
    // Methods
    public rewind(bytes: number[], ndx: number): number {
        let buff = [];
        //buff.push(...this.padding);
        //buff.push(...this.preamble);
        buff.push(...this.header);
        buff.push(...this.payload);
        buff.push(...this.term);
        // Add in the remaining bytes.
        if (ndx < bytes.length - 1) buff.push(...bytes.slice(ndx, bytes.length - 1));
        this.padding.push(...this.preamble);
        this.preamble.length = 0;
        this.header.length = 0;
        this.payload.length = 0;
        this.term.length = 0;
        buff.shift();
        this.protocol = Protocol.Unknown;
        this._complete = false;
        this.isValid = true;

        this.collisions++;
        this.rewinds++;
        logger.info(`rewinding message collision ${this.collisions} ${ndx} ${bytes.length} ${JSON.stringify(buff)}`);
        this.readPacket(buff);
        return ndx;
        //return this.padding.length + this.preamble.length;
    }
    public readPacket(bytes: number[]): number {
        //logger.info(`BYTES: ${JSON.stringify(bytes)}`);
        var ndx = this.readHeader(bytes, 0);
        if (this.isValid && this.header.length > 0) ndx = this.readPayload(bytes, ndx);
        if (this.isValid && this.header.length > 0) ndx = this.readChecksum(bytes, ndx);
        if (this.isComplete && !this.isValid) return this.rewind(bytes, ndx);
        return ndx;
    }
    public mergeBytes(bytes) {
        var ndx = 0;
        if (this.header.length === 0) ndx = this.readHeader(bytes, ndx);
        if (this.isValid && this.header.length > 0) ndx = this.readPayload(bytes, ndx);
        if (this.isValid && this.header.length > 0) ndx = this.readChecksum(bytes, ndx);
        //if (this.isComplete && !this.isValid) return this.rewind(bytes, ndx);
        return ndx;
    }
    public readHeader(bytes: number[], ndx: number): number {
        // start over to include the padding bytes.
        //if (this.protocol !== Protocol.Unknown) {
        //    logger.warn(`${this.protocol} resulted in an empty message header ${JSON.stringify(this.header)}`);
        //}
        let ndxStart = ndx;
        // RKS: 05-30-22 -- OMG we have not been dealing with short headers.  As a result it was restarting
        // the header process even after it had identified it.
        if (this.protocol === Protocol.Unknown) {
            while (ndx < bytes.length) {
                if (this.testBroadcastHeader(bytes, ndx)) {
                    this.protocol = Protocol.Broadcast;
                    break;
                }
                if (this.testUnidentifiedHeader(bytes, ndx)) {
                    this.protocol = Protocol.Unidentified;
                    break;
                }
                if (this.testChlorHeader(bytes, ndx)) {
                    this.protocol = Protocol.Chlorinator;
                    break;
                }
                if (this.testAquaLinkHeader(bytes, ndx)) {
                    this.protocol = Protocol.AquaLink;
                    break;
                }
                if (this.testHaywardHeader(bytes, ndx)) {
                    this.protocol = Protocol.Hayward;
                    break;
                }
                this.padding.push(bytes[ndx++]);
            }
        }
        // When the code above finds a protocol, ndx will be at the start of that
        // header.  If it is not identified then it will rewind to the initial
        // start position until we get more bytes.  This is the default case below.
        let ndxHeader = ndx;
        switch (this.protocol) {
            case Protocol.Pump:
            case Protocol.IntelliChem:
            case Protocol.IntelliValve:
            case Protocol.Broadcast:
            case Protocol.Heater:
            case Protocol.Unidentified:
                ndx = this.pushBytes(this.preamble, bytes, ndx, 3);
                ndx = this.pushBytes(this.header, bytes, ndx, 6);
                if (this.header.length < 6) {
                    // We actually don't have a complete header yet so just return.
                    // we will pick it up next go around.
                    // logger.debug(`We have an incoming message but the serial port hasn't given a complete header. [${this.padding}][${this.preamble}][${this.header}]`);
                    //logger.info(`We don't have a complete header ${JSON.stringify(this.header)}`);
                    this.preamble = [];
                    this.header = [];
                    return ndxHeader;
                }
                if (this.source >= 96 && this.source <= 111) this.protocol = Protocol.Pump;
                else if (this.dest >= 96 && this.dest <= 111) this.protocol = Protocol.Pump;
                else if (this.source >= 112 && this.source <= 127) this.protocol = Protocol.Heater;
                else if (this.dest >= 112 && this.dest <= 127) this.protocol = Protocol.Heater;
                else if (this.dest >= 144 && this.dest <= 158) this.protocol = Protocol.IntelliChem;
                else if (this.source >= 144 && this.source <= 158) this.protocol = Protocol.IntelliChem;
                else if (this.source == 12 || this.dest == 12) this.protocol = Protocol.IntelliValve;
                if (this.datalen > 75) {
                    //this.isValid = false;
                    logger.debug(`Broadcast length ${this.datalen} exceeded 75 bytes for ${this.protocol} message. Message rewound ${this.header}`);
                    this.padding.push(...this.preamble);
                    this.padding.push(...this.header.slice(0, 1));
                    this.preamble = [];
                    this.header = [];
                    this.collisions++;
                    this.rewinds++;
                    return ndxHeader + 1;
                }
                break;
            case Protocol.Chlorinator:
                // RKS: 06-06-20 We occasionally get messages where the 16, 2 is interrupted.  The message below
                // has an IntelliValve broadcast embedded within as well as a chlorinator status request. So
                // in the instance below we have two messages being tossed because something on the bus interrupted
                // the chlorinator.  The first 240 byte does not belong to the chlorinator nor does it belong to
                // the IntelliValve
                //[][16, 2, 240][255, 0, 255, 165, 1, 16, 12, 82, 8, 0, 128, 216, 128, 57, 64, 25, 166, 4, 44, 16, 2, 80, 17, 0][115, 16, 3]
                //[][16, 2, 80, 17][0][115, 16, 3]
                ndx = this.pushBytes(this.header, bytes, ndx, 4);
                if (this.header.length < 4) {
                    // We actually don't have a complete header yet so just return.
                    // we will pick it up next go around.
                    logger.debug(`We have an incoming chlorinator message but the serial port hasn't given a complete header. [${this.padding}][${this.preamble}][${this.header}]`);
                    this.preamble = [];
                    this.header = [];
                    return ndxHeader;
                }
                break;
            case Protocol.Hayward:
                ndx = this.pushBytes(this.header, bytes, ndx, 5);
                if (this.header.length < 4) {
                    // We actually don't have a complete header yet so just return.
                    // we will pick it up next go around.
                    logger.debug(`We have an incoming Hayward message but the serial port hasn't given a complete header. [${this.padding}][${this.preamble}][${this.header}]`);
                    this.preamble = [];
                    this.header = [];
                    return ndxHeader;
                }
                break;
            case Protocol.AquaLink:
                ndx = this.pushBytes(this.header, bytes, ndx, 5);
                if (this.header.length < 5) {
                    // We actually don't have a complete header yet so just return.
                    // we will pick it up next go around.
                    logger.debug(`We have an incoming AquaLink message but the serial port hasn't given a complete header. [${this.padding}][${this.preamble}][${this.header}]`);
                    this.preamble = [];
                    this.header = [];
                    return ndxHeader;
                }
                break;
            default:
                // We didn't get a message signature. don't do anything with it.
                ndx = ndxStart;
                if (bytes.length > 24) {
                    // The length of the incoming bytes have exceeded 24 bytes.  This is very likely
                    // flat out garbage on the serial port.  Strip off all but the last 5 preamble + signature bytes and move on.  Heck we aren't even
                    // going to keep them.
                    // 255, 255, 255, 0, 255
                    ndx = bytes.length - 5;
                    let arr = bytes.slice(0, ndx);
                    // Remove all but the last 4 bytes.  This will result in nothing anyway.
                    logger.verbose(`[Port ${this.portId}] Tossed Inbound Bytes ${arr} due to an unrecoverable collision.`);
                    
                    // Check if we're getting a flood of null bytes which indicates a communication breakdown
                    let nullByteCount = arr.filter(b => b === 0).length;
                    if (nullByteCount > arr.length * 0.8) { // More than 80% null bytes
                        // Emit a collision event that the port can handle for recovery
                        if (typeof this.portId !== 'undefined') {
                            const conn = require('../../comms/Comms').conn;
                            const port = conn.findPortById(this.portId);
                            if (port && typeof port.handleCollisionFlood === 'function') {
                                port.handleCollisionFlood();
                            }
                        }
                    }
                }
                this.padding = [];
                break;
        }
        return ndx;
    }
    public readPayload(bytes: number[], ndx: number): number {
        //if (!this.isValid) return bytes.length;
        if (!this.isValid) return ndx;
        switch (this.protocol) {
            case Protocol.Broadcast:
            case Protocol.Pump:
            case Protocol.IntelliChem:
            case Protocol.IntelliValve:
            case Protocol.Heater:
            case Protocol.Unidentified:
                if (this.datalen - this.payload.length <= 0) {
                    let buff = bytes.slice(ndx - 1);
                    //logger.info(`We don't need any more payload ${this.datalen - this.payload.length} ${ndx} ${JSON.stringify(buff)};`);
                    return ndx; // We don't need any more payload.
                }
                ndx = this.pushBytes(this.payload, bytes, ndx, this.datalen - this.payload.length);
                break;
            case Protocol.Chlorinator:
                // We need to deal with chlorinator packets where the terminator is actually split meaning only the first byte or
                // two of the total payload is provided for the term.  We need at least 3 bytes to make this determination.
                while (ndx + 3 <= bytes.length && !this.testChlorTerm(bytes, ndx)) {
                    this.payload.push(bytes[ndx++]);
                    if (this.payload.length > 25) {
                        this.isValid = false; // We have a runaway packet.  Some collision occurred so lets preserve future packets.
                        logger.debug(`Chlorinator message marked as invalid after not finding 16,3 in payload after ${this.payload.length} bytes`);
                        break;
                    }
                }
                break;
            case Protocol.AquaLink:
                // We need to deal with AquaLink packets where the terminator is actually split meaning only the first byte or
                // two of the total payload is provided for the term.  We need at least 3 bytes to make this determination.
                while (ndx + 3 <= bytes.length && !this.testAquaLinkTerm(bytes, ndx)) {
                    this.payload.push(bytes[ndx++]);
                    if (this.payload.length > 25) {
                        this.isValid = false; // We have a runaway packet.  Some collision occurred so lets preserve future packets.
                        logger.debug(`AquaLink message marked as invalid after not finding 16,3 in payload after ${this.payload.length} bytes`);
                        break;
                    }
                }
                break;
            case Protocol.Hayward:
                // We need to deal with AquaLink packets where the terminator is actually split meaning only the first byte or
                // two of the total payload is provided for the term.  We need at least 3 bytes to make this determination.
                while (ndx + 4 <= bytes.length && !this.testHaywardTerm(bytes, ndx)) {
                    this.payload.push(bytes[ndx++]);
                    if (this.payload.length > 25) {
                        this.isValid = false; // We have a runaway packet.  Some collision occurred so lets preserve future packets.
                        logger.debug(`Hayward message marked as invalid after not finding 16,3 in payload after ${this.payload.length} bytes`);
                        break;
                    }
                }
                break;

        }
        return ndx;
    }
    public readChecksum(bytes: number[], ndx: number): number {
        if (!this.isValid) return bytes.length;
        if (ndx >= bytes.length) return ndx;
        switch (this.protocol) {
            case Protocol.Broadcast:
            case Protocol.Pump:
            case Protocol.IntelliValve:
            case Protocol.IntelliChem:
            case Protocol.Heater:
            case Protocol.Unidentified:
                // If we don't have enough bytes to make the terminator then continue on and
                // hope we get them on the next go around.
                if (this.payload.length >= this.datalen && ndx + 2 <= bytes.length) {
                    this._complete = true;
                    ndx = this.pushBytes(this.term, bytes, ndx, 2);
                    this.isValid = this.isValidChecksum();
                }
                break;
            case Protocol.Chlorinator:
                if (ndx + 3 <= bytes.length && this.testChlorTerm(bytes, ndx)) {
                    this._complete = true;
                    ndx = this.pushBytes(this.term, bytes, ndx, 3);
                    this.isValid = this.isValidChecksum();
                }
                break;
            case Protocol.AquaLink:
                if (ndx + 3 <= bytes.length && this.testAquaLinkTerm(bytes, ndx)) {
                    this._complete = true;
                    ndx = this.pushBytes(this.term, bytes, ndx, 3);
                    this.isValid = this.isValidChecksum();
                }
                break;
            case Protocol.Hayward:
                if (ndx + 4 <= bytes.length && this.testHaywardTerm(bytes, ndx)) {
                    this._complete = true;
                    ndx = this.pushBytes(this.term, bytes, ndx, 4);
                    this.isValid = this.isValidChecksum();
                }
                break;

        }
        return ndx;
    }
    public extractPayloadString(start: number, length: number) {
        var s = '';
        for (var i = start; i < this.payload.length && i < start + length; i++) {
            if (this.payload[i] <= 0) break;
            s += String.fromCharCode(this.payload[i]);
        }
        return s;
    }
    // return Little Endian Int
    public extractPayloadInt(ndx: number, def?: number) {
        return ndx + 1 < this.payload.length ? (this.payload[ndx + 1] * 256) + this.payload[ndx] : def;

    }
    // return Big Endian Int
    public extractPayloadIntBE(ndx: number, endian = 'le', def?: number) {
        return ndx + 1 < this.payload.length ? (this.payload[ndx] * 256) + this.payload[ndx + 1] : def;
    }
    public extractPayloadByte(ndx: number, def?: number) {
        return ndx < this.payload.length ? this.payload[ndx] : def;
    }
    private processBroadcast(): void {
        if (this.action !== 2 && !state.isInitialized) {
            // RKS: This is a placeholder for now so that messages aren't processed until we
            // are certain who is on the other end of the wire. Once the system config is normalized
            // we won't need this check here anymore.
            return;
        }
        switch (sys.controllerType) {
            // RKS: 10-10-20 - We have a message somewhere that is ending up in a process for one of the other controllers. This
            // makes sure we are processing every message and alerting when a message is not being processed.
            case ControllerType.IntelliCenter:
                switch (this.action) {
                    case 1: // ACK
                        this.isProcessed = true;
                        break;
                    case 2:
                    case 204:
                        EquipmentStateMessage.process(this);
                        break;
                    case 30:
                        ConfigMessage.process(this);
                        break;
                    case 147: // Not sure whether this is only for *Touch. If it is not then it probably should have been caught by the protocol.
                        IntelliChemStateMessage.process(this);
                        break;
                    case 164:
                        VersionMessage.process(this);
                        break;
                    case 168:
                        ExternalMessage.processIntelliCenter(this);
                        break;
                    case 222: // A panel is asking for action 30s
                    case 228: // A panel is asking for the current version
                        this.isProcessed = true;
                        break;
                    default:
                        logger.info(`An unprocessed message was received ${this.toPacket()}`)
                        break;

                }
                if (!this.isProcessed) logger.info(`The message was not processed ${this.action} - ${this.toPacket()}`);
                break;
            default:
                switch (this.action) {
                    case 1: // Ack
                        break;
                    case 2:  // Shared IntelliCenter/IntelliTouch
                    case 5:
                    case 8:
                    case 96: // intellibrite lights
                        EquipmentStateMessage.process(this);
                        break;
                    // IntelliTouch
                    case 10:
                        CustomNameMessage.process(this);
                        break;
                    case 11:
                        CircuitMessage.processTouch(this);
                        break;
                    case 25:
                        ChlorinatorMessage.processTouch(this);
                        break;
                    case 153:
                        ExternalMessage.processTouchChlorinator(this);
                        break;
                    case 17:
                    case 145:
                        ScheduleMessage.process(this);
                        break;
                    case 18:
                        IntellichemMessage.process(this);
                        break;
                    case 24:
                    case 27:
                    case 152:
                    case 155:
                        PumpMessage.process(this);
                        break;
                    case 30:
                        switch (sys.controllerType) {
                            case ControllerType.Unknown:
                                break;
                            case ControllerType.SunTouch:
                                ScheduleMessage.processSunTouch(this);
                                break;
                            default:
                                OptionsMessage.process(this);
                                break;
                        }
                        break;
                    case 22:
                    case 32:
                    case 33:
                        RemoteMessage.process(this);
                        break;
                    case 29:
                    case 35:
                        ValveMessage.process(this);
                        break;
                    case 39:
                    case 167:
                        CircuitMessage.processTouch(this);
                        break;
                    case 40:
                    case 168:
                        OptionsMessage.process(this);
                        break;
                    case 41:
                        CircuitGroupMessage.process(this);
                        break;
                    case 197:
                        EquipmentStateMessage.process(this);    // Date/Time request
                        break;
                    case 252:
                        EquipmentMessage.process(this);
                        break;
                    case 9:
                    case 16:
                    case 34:
                    case 137:
                    case 144:
                    case 162:
                        HeaterMessage.process(this);
                        break;
                    case 114:
                    case 115:
                        HeaterStateMessage.process(this);
                        break
                    case 147:
                        IntellichemMessage.process(this);
                        break;
                    case 136:
                        ExternalMessage.processTouchSetHeatMode(this);
                        break;
                    default:
                        if (this.action === 109 && this.payload[1] === 3) break;
                        if (this.source === 17 && this.payload[0] === 109) break;
                        logger.debug(`Packet not processed: ${this.toPacket()}`);
                        break;
                }
                break;
        }
    }
    public process() {
        let port = conn.findPortById(this.portId);
        if (this.portId === sys.anslq25.portId) {
            return MessagesMock.process(this);
        }
        if (port.mock && port.hasAssignedEquipment()){
            return MessagesMock.process(this);
        }
        switch (this.protocol) {
            case Protocol.Broadcast:
                this.processBroadcast();
                break;
            case Protocol.IntelliValve:
                IntelliValveStateMessage.process(this);
                break;
            case Protocol.IntelliChem:
                IntelliChemStateMessage.process(this);
                break;
            case Protocol.Pump:
                if ((this.source >= 96 && this.source <= 111) || (this.dest >= 96 && this.dest <= 111))
                    PumpStateMessage.process(this);
                else
                    this.processBroadcast();
                break;
            case Protocol.Heater:
                HeaterStateMessage.process(this);
                break;
            case Protocol.Chlorinator:
                ChlorinatorStateMessage.process(this);
                break;
            case Protocol.Hayward:
                PumpStateMessage.processHayward(this);
                break;
            default:
                logger.debug(`Unprocessed Message ${this.toPacket()}`)
                break;
        }
    }
}
class OutboundCommon extends Message {
    public set sub(val: number) { if (this.protocol !== Protocol.Chlorinator && this.protocol !== Protocol.AquaLink) this.header[1] = val; }
    public get sub() { return super.sub; }
    public set dest(val: number) {
        if (this.protocol === Protocol.Chlorinator) this.header[2] = val;
        else if (this.protocol === Protocol.Hayward) this.header[4] = val;
        else this.header[2] = val;
    }
    public get dest() { return super.dest; }
    public set source(val: number) {
        switch (this.protocol) {
            case Protocol.Chlorinator:
                break;
            case Protocol.Hayward:
                this.header[3] = val;
                break;
            default:
                this.header[3] = val;
                break;
        }
        //if (this.protocol === Protocol.Hayward) this.header[2] = val;
        //else if (this.protocol !== Protocol.Chlorinator) this.header[3] = val;
    }
    public get source() { return super.source; }
    public set action(val: number) {
        switch (this.protocol) {
            case Protocol.Chlorinator:
                this.header[3] = val;
                break;
            case Protocol.Hayward:
                this.header[2] = val;
                break;
            default:
                this.header[4] = val;
                break;
        }
    }
    public get action() { return super.action; }
    public set datalen(val: number) { if (this.protocol !== Protocol.Chlorinator && this.protocol !== Protocol.Hayward) this.header[5] = val; }
    public get datalen() { return super.datalen; }
    public set chkHi(val: number) { if (this.protocol !== Protocol.Chlorinator) this.term[0] = val; }
    public get chkHi() { return super.chkHi; }
    public set chkLo(val: number) { if (this.protocol !== Protocol.Chlorinator) this.term[1] = val; else this.term[0] = val; }
    public get chkLo() { return super.chkLo; }
    // Methods
    public calcChecksum() {
        this.datalen = this.payload.length;
        let sum: number = this.checksum;
        switch (this.protocol) {
            case Protocol.Pump:
            case Protocol.Broadcast:
            case Protocol.IntelliValve:
            case Protocol.Unidentified:
            case Protocol.IntelliChem:
            case Protocol.Heater:
            case Protocol.Hayward:
                this.chkHi = Math.floor(sum / 256);
                this.chkLo = (sum - (super.chkHi * 256));
                break;
            case Protocol.AquaLink:
            case Protocol.Chlorinator:
                this.term[0] = sum % 256;
                break;
        }
    }
}
export class Outbound extends OutboundCommon {
    constructor(proto: Protocol, source: number, dest: number, action: number, payload: number[], retries?: number, response?: Response | boolean, scope?: string) {
        super();
        this.id = Message.nextMessageId;
        this.protocol = proto;
        this.direction = Direction.Out;
        this.retries = retries || 0;
        this.preamble.length = 0;
        this.header.length = 0;
        this.term.length = 0;
        this.payload.length = 0;
        if (proto === Protocol.Chlorinator || proto === Protocol.AquaLink) {
            this.header.push.apply(this.header, [16, 2, 0, 0]);
            this.term.push.apply(this.term, [0, 16, 3]);
        }
        else if (proto === Protocol.Broadcast) {
            this.preamble.push.apply(this.preamble, [255, 0, 255]);
            this.header.push.apply(this.header, [165, Message.headerSubByte, 15, Message.pluginAddress, 0, 0]);
            this.term.push.apply(this.term, [0, 0]);
        }
        else if (proto === Protocol.Pump || proto === Protocol.IntelliValve || proto === Protocol.IntelliChem || proto === Protocol.Heater) {
            this.preamble.push.apply(this.preamble, [255, 0, 255]);
            this.header.push.apply(this.header, [165, 0, 15, Message.pluginAddress, 0, 0]);
            this.term.push.apply(this.term, [0, 0]);
        }
        else if (proto === Protocol.Hayward) {
            this.header.push.apply(this.header, [16, 2, 0, 0, 0]);
            this.term.push.apply(this.term, [0, 0, 16, 3]);
        }
        this.scope = scope;
        this.source = source;
        this.dest = dest;
        this.action = action;
        this.payload.push.apply(this.payload, payload);
        this.calcChecksum();
        if (typeof response === "boolean" && response)
            this.response = Response.create({ protocol: this.protocol, response: true });
        else
            this.response = response as Response;
    }
    // Factory
    public static create(obj?: any) {
        let o = extend({
            protocol: Protocol.Broadcast,
            source: sys.board.commandSourceAddress || Message.pluginAddress,
            dest: sys.board.commandDestAddress || 16,
            action: 0,
            payload: [],
            retries: 0,
            response: false,
        }, obj, true);
        let out = new Outbound(o.protocol, o.source, o.dest, o.action, o.payload, o.retries, o.response, o.scope);
        //let out = new Outbound(obj.protocol || Protocol.Broadcast,
        //    obj.source || sys.board.commandSourceAddress || Message.pluginAddress, obj.dest || sys.board.commandDestAddress || 16, obj.action || 0, obj.payload || [], obj.retries || 0, obj.response || false, obj.scope || undefined);
        out.portId = obj.portId || 0;
        out.onComplete = obj.onComplete;
        out.onAbort = obj.onAbort;
        out.timeout = obj.timeout;
        for (let i = 0; i < out.header.length; i++) {
            if (out.header[i] >= 0 && out.header[i] <= 255 && out.header[i] !== null && typeof out.header[i] !== 'undefined') continue;
            throw new OutboundMessageError(out, `Invalid header detected: ${out.toShortPacket()}`);
        }
        for (let i = 0; i < out.payload.length; i++) {
            if (out.payload[i] >= 0 && out.payload[i] <= 255 && out.payload[i] !== null && typeof out.payload[i] !== 'undefined') continue;
            throw new OutboundMessageError(out, `Invalid payload detected: ${out.toShortPacket()}`);
        }
        return out;
    }
    public static createMessage(action: number, payload: number[], retries?: number, response?: Response | boolean): Outbound {
        return new Outbound(Protocol.Broadcast, sys.board.commandSourceAddress || Message.pluginAddress, sys.board.commandDestAddress || 16, action, payload, retries, response);
    }
    public async sendAsync() {
        return conn.queueSendMessageAsync(this);
    }
    // Fields
    public retries: number = 0;
    public tries: number = 0;
    public timeout: number = 1000;
    public response: Response;
    public failed: boolean = false;
    public onComplete: (error: Error, msg: Inbound) => void;
    public onAbort: () => void;
    // Properties
    public get requiresResponse(): boolean {
        if (typeof this.response === 'undefined' || (typeof this.response === 'boolean' && !this.response)) return false;
        if (this.response instanceof Response || typeof this.response === 'function') { return true; }
        return false;
    }
    public get remainingTries(): number { return this.retries - this.tries + 1; } // Always allow 1 try.
    public setPayloadByte(ndx: number, value: number, def?: number) {
        if (typeof value === 'undefined' || isNaN(value)) value = def;
        if (ndx < this.payload.length) this.payload[ndx] = value;
        return this;
    }
    public appendPayloadByte(value: number, def?: number) {
        if (typeof value === 'undefined' || isNaN(value)) value = def;
        this.payload.push(value);
        return this;
    }
    public appendPayloadBytes(value: number, len: number) {
        for (let i = 0; i < len; i++) this.payload.push(value);
        return this;
    }
    public setPayloadBytes(value: number, len: number) {
        for (let i = 0; i < len; i++) {
            if (i < this.payload.length) this.payload[i] = value;
        }
        return this;
    }
    public insertPayloadBytes(ndx: number, value: number, len: number) {
        let buf = [];
        for (let i = 0; i < len; i++) {
            buf.push(value);
        }
        this.payload.splice(ndx, 0, ...buf);
        return this;
    }
    public setPayloadInt(ndx: number, value: number, def?: number) {
        if (typeof value === 'undefined' || isNaN(value)) value = def;
        let b1 = Math.floor(value / 256);
        let b0 = value - (b1 * 256);
        if (ndx < this.payload.length) this.payload[ndx] = b0;
        if (ndx + 1 < this.payload.length) this.payload[ndx + 1] = b1;
        return this;
    }
    public appendPayloadInt(value: number, def?: number) {
        if (typeof value === 'undefined' || isNaN(value)) value = def;
        let b1 = Math.floor(value / 256);
        let b0 = value - (b1 * 256);
        this.payload.push(b0);
        this.payload.push(b1);
        return this;
    }
    public insertPayloadInt(ndx: number, value: number, def?: number) {
        if (typeof value === 'undefined' || isNaN(value)) value = def;
        let b1 = Math.floor(value / 256);
        let b0 = (value - b1) * 256;
        this.payload.splice(ndx, 0, b0, b1);
        return this;
    }
    public setPayloadString(s: string, len?: number, def?: string) {
        if (typeof s === 'undefined') s = def;
        for (var i = 0; i < s.length; i++) {
            if (i < this.payload.length) this.payload[i] = s.charCodeAt(i);
        }
        if (typeof (len) !== 'undefined') {
            for (var j = i; j < len; j++)
                if (i < this.payload.length) this.payload[i] = 0;
        }
        return this;
    }
    public appendPayloadString(s: string, len?: number, def?: string) {
        if (typeof s === 'undefined') s = def;
        for (var i = 0; i < s.length; i++) {
            if (typeof (len) !== 'undefined' && i >= len) break;
            this.payload.push(s.charCodeAt(i));
        }
        if (typeof (len) !== 'undefined') {
            for (var j = i; j < len; j++) this.payload.push(0);
        }
        return this;
    }
    public insertPayloadString(start: number, s: string, len?: number, def?: string) {
        if (typeof s === 'undefined') s = def;
        let l = typeof len === 'undefined' ? s.length : len;
        let buf = [];
        for (let i = 0; i < l; i++) {
            if (i < s.length) buf.push(s.charCodeAt(i));
            else buf.push(0);
        }
        this.payload.splice(start, l, ...buf);
        return this;
    }
    public toPacket(): number[] {
        var pkt = [];
        this.calcChecksum();
        pkt.push.apply(pkt, this.padding);
        pkt.push.apply(pkt, this.preamble);
        pkt.push.apply(pkt, this.header);
        pkt.push.apply(pkt, this.payload);
        pkt.push.apply(pkt, this.term);
        return pkt;
    }
    public processMock(){
        // When the port is a mock port, we are no longer sending an
        // outbound message but converting it to an inbound and
        // skipping the actual send/receive part of the comms.
        let inbound = Message.convertOutboundToInbound(this);
        let port = conn.findPortById(this.portId);
        if (port.hasAssignedEquipment() || this.portId === sys.anslq25.portId){
            MessagesMock.process(inbound);
        }
        else {
            inbound.process();
        }
    
    }
}
export class Ack extends Outbound {
    constructor(byte: number) {
        super(Protocol.Broadcast, Message.pluginAddress, 15, 1, [byte]);
    }
}
export class Response extends OutboundCommon {
    /*
    RG 6-2021: This class is now purely for identifying inbound messages and it is a property of the Outbound message.
    This can be created by passing response: Response.create({}) or response: boolean to the Outbound message.
    Response used to accept a function but that is deprecated.
    Response also no longer needs to be passed msgOut because that is the parent object/message and can be
    accessed via the internal symbol parent.  
    */
    public message: Inbound;
    // rsg moved accessors here because we won't have a full header; just set/check the individual byte.
    public set action(val: number) { (this.protocol !== Protocol.Chlorinator) ? this.header[4] = val : this.header[3] = val; }
    public get action(): number {
        if (this.protocol === Protocol.Chlorinator) return this.header[3];
        else if (typeof this.header[4] !== 'undefined') return this.header[4]
        else return -1;
    }
    constructor(proto: Protocol, source: number, dest: number, action?: number, payload?: number[], ack?: number, callback?: (err, msg?: Outbound) => void) {
        super();
        this.protocol = proto;
        this.direction = Direction.In;
        this.source = source;
        this.dest = dest;
        this.action = action;
        if (typeof payload !== 'undefined' && payload.length > 0) this.payload.push(...payload);
        if (typeof ack !== 'undefined' && ack !== null) this.ack = new Ack(ack);
        this.callback = callback;
    }
    public static create(obj?: any) {
        let res = new Response(obj.protocol || Protocol.Broadcast,
            obj.source || Message.pluginAddress, obj.dest || 16, obj.action || 0, obj.payload || [], obj.ack, obj.callback);
        res.responseBool = obj.response;
        if (typeof obj.action !== 'undefined') res.responseBool = true;
        return res;
    }
    // Fields
    public ack: Ack;
    public callback: (err, msg?: Outbound) => void;
    public responseBool: boolean;  // if `response: true|false` is passed to the Outbound message we will store that input here

    // Methods
    public isResponse(msgIn: Inbound, msgOut?: Outbound): boolean {
        let bresp = false;;
        try {
            if (typeof this.responseBool === 'boolean' && this.responseBool) bresp = this.evalResponse(msgIn, msgOut);
            else return bresp;
            if (bresp === true && typeof msgOut !== 'undefined') {
                msgIn.responseFor.push(msgOut.id);
                logger.silly(`Message in ${msgIn.id} is a response for message out ${msgOut.id}`);
            }
            return bresp;
        }
        catch (err) { }
    }

    public evalResponse(msgIn: Inbound, msgOut?: Outbound): boolean {
        // this holds the logic to determine if an inbound message is a response.  
        // Aka is this Response object
        // a response to the parent message of Outbound class.
        if (typeof msgOut === 'undefined') return false;
        if (msgIn.protocol !== msgOut.protocol) { return false; }
        if (typeof msgIn === 'undefined') { return false; } // getting here on msg send failure

        // if these properties were set on the Response (this) object via creation,
        // then use the passed in values.  Otherwise, use the msgIn/msgOut matching rules        
        if (this.action > 0 && this.payload.length > 0) {
            if (this.action === msgIn.action) {
                for (let i = 0; i < msgIn.payload.length; i++) {
                    if (i > this.payload.length - 1)
                        return false;
                    if (this.payload[i] !== msgIn.payload[i]) return false;
                    return true;
                }
            }
        }
        else if (this.action > 0) {
            if (this.action === msgIn.action) return true;
            else return false;
        }
        else if (msgOut.protocol === Protocol.Pump) {
            switch (msgIn.action) {
                case 7:
                    // Scenario 1.  Request for pump status.
                    // Msg In:     [165,0,16, 96, 7,15], [4,0,0,0, 0, 0, 0, 0, 0, 0, 0, 0, 0,17,31], [1,95]
                    // Msg Out:    [165,0,96, 16, 7, 0],[1,28]
                    if (msgIn.source !== msgOut.dest || (msgIn.dest !== msgOut.source && msgIn.dest != 16)) { return false; }
                    if (msgIn.action === 7 && msgOut.action === 7) { return true; }
                    return false;
                default:
                    //Scenario 2, pump messages are mimics of each other but the dest/src are swapped
                    if (msgIn.source !== msgOut.dest || (msgIn.dest !== msgOut.source && msgIn.dest != 16)) { return false; }
                    // sub-case                           
                    // Msg In:     [165,0,16, 96, 1, 2], [3,32],[1,59]
                    // Msg Out:    [165,0,96,16, 1,4],[3,39, 3,32], [1,103]
                    if (msgIn.payload[0] === msgOut.payload[2] && msgIn.payload[1] === msgOut.payload[3]) { return true; }
                    // else mimics
                    if (JSON.stringify(msgIn.payload) === JSON.stringify(msgOut.payload)) { return true; }
                    return false;
            }
        }
        else if (msgIn.protocol === Protocol.Chlorinator) {
            switch (msgIn.action) {
                case 1:
                    return msgOut.action === 0 ? true : false;
                case 3:
                    return msgOut.action === 20 ? true : false;
                case 18:
                case 21:
                case 22:
                    return msgOut.action === 17 ? true : false;
                default:
                    return false;
            }
        }
        else if (msgIn.protocol === Protocol.IntelliChem) {
            switch (msgIn.action) {
                case 1: // ack
                    if (msgIn.source === msgOut.dest && msgIn.payload[0] === msgOut.action) return true;
                    break;
                default:
                    // in: 18; out 210 fits parent & 0x63 pattern
                    if (msgIn.action === (msgOut.action & 63) && msgIn.source === msgOut.dest) return true;
                    return false;
            }
        }
        else if (sys.controllerType !== ControllerType.IntelliCenter) {
            switch (msgIn.action) {
                // these responses have multiple items so match the 1st payload byte
                case 1: // ack
                    if (msgIn.payload[0] === msgOut.action) return true;
                    break;
                case 10:
                case 11:
                case 17:
                    if (msgIn.action === (msgOut.action & 63) && msgIn.payload[0] === msgOut.payload[0]) return true;
                    break;
                case 252:
                    if (msgOut.action === 253) return true;
                    break;
                default:
                    if (msgIn.action === (msgOut.action & 63)) return true;
            }
            return false;
        }
        else if (sys.controllerType === ControllerType.IntelliCenter) {
            // intellicenter packets
            if (this.dest >= 0 && msgIn.dest !== this.dest) return false;
            for (let i = 0; i < this.payload.length; i++) {
                if (i > msgIn.payload.length - 1)
                    return false;
                //console.log({ msg: 'Checking response', p1: msgIn.payload[i], pd: this.payload[i] });
                if (msgIn.payload[i] !== this.payload[i]) return false;
            }
            return true;
        }
    }
}