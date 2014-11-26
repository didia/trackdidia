'''
Created on 2014-11-20

@author: didia
'''
from google.appengine.ext import ndb

from .custom_exceptions import SlotAlreadyUsed, BadArgumentError
from slot import Slot

class DayOfWeek(ndb.Model):
    interval_usage = ndb.BooleanProperty(repeated = True)
    _slots = None
    
    def _validate_offset_and_duration(self, offset, duration):
        higher_limit = len(self.interval_usage)
        if(offset < 0 or offset >= higher_limit):
            message = "The offset parameter must be a number betwen "
            message += str(0) + " and "+ str(higher_limit) + ". " + str(offset) + " given"
            
            raise BadArgumentError(message)
        
        if(offset + duration > higher_limit):
            message = "The sum of the offset + duration must be less than "
            message = "the number of available slots, " + str(higher_limit)
            
            raise BadArgumentError(message)
        
    def add_slot(self, task, offset, duration):
        self._validate_offset_and_duration(offset, duration)
        for i in range(offset, offset+duration):
            if(self.interval_usage[i]):
                message = "Asked to reserve Slot " + str(offset)
                if duration > 1:
                    message +=" to " +  str(offset+duration-1) + " inclusively"
                message += "\n But Slot " + str(i) + " is already reserved"
                
                raise SlotAlreadyUsed(message)
                
        slot = Slot(parent=self.key, task=task.key, offset= offset, duration = duration)
        slot.put()
        for i in range(offset, offset+duration):
            self.interval_usage[i] = True
        self.put()
        
        if not self._slots is None:
            self._slots.append(slot)
        return slot
    
    def add_slots(self):
        pass
    
    def get_slot(self, slot_id):
        return Slot.get_by_id(slot_id,self.key)
    
    def get_slots(self):
        if self._slots is None:
            self.reload_slots()
        return self._slots
    
    def reload_slots(self):
        self._slots = Slot.query(ancestor=self.key).order(Slot.offset).fetch()
        if self._slots is None:
            self._slots = []
    
    def remove_slot(self, slot_id):
        slot = self.get_slot(slot_id)
        if not slot is None:
            for i in range(slot.offset, slot.offset + slot.duration):
                self.interval_usage[i] = False
            
            if not self._slots is None:
                try:
                    self._slots.remove(slot)
                except ValueError:
                    pass
            slot.key.delete()
            self.put()
            

    def set_executed(self, slot_id, executed=True):
 
        if(type(slot_id)) is dict:
            slots = []
            for key, value in slot_id.iteritems():
                slot = self.get_slot(key)
                slot.executed = value
                slots.append(slot)
            ndb.put_multi(slots)
            return slots
                 
        else:
            slot = self.get_slot(slot_id)
            slot.executed = executed
            slot.put()
            return slot;
    
    def restart(self):
        slots = self.get_slots()
        for slot in slots :
            slot.executed = False
        ndb.put_multi(slots)
        
    def get_executed_slots(self):
        return Slot.query(ancestor=self.key).filter(Slot.executed == True).fetch()
        
    