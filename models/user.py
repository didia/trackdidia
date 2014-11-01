'''
Created on 2014-10-28

@author: didia
'''
from google.appengine.api.datastore_errors import BadValueError
from google.appengine.ext import ndb

from custom_exceptions import BadArgumentError
from task import Task
from tracking import Schedule



def create_user(user_id, email, nickname):
    my_user = User(id=user_id, email=email, nickname=nickname)
    my_user.put()
    my_user.init_schedule()
    
    return my_user;

def get_user(user_id):
    return User.get_by_id(user_id)

def get_or_create_user(user_id, email, nickname):
    user = get_user(user_id)
    return user or create_user(user_id, email, nickname)
    

def delete_user(user_id):
    key = ndb.Key(User, user_id)
    key.delete()
    
class User(ndb.Model):
    '''
    Stores a user information
    '''
    email = ndb.StringProperty(required=True)
    nickname = ndb.StringProperty(required=True)
    schedule = None
    
    def get_id(self):
        return self.key.id()
    
    def get_email(self):
        return self.email
    
    def get_nickname(self):
        return self.nickname
    
    def update(self, **kwargs):
        if kwargs is None:
            return
        updated_values = {}
        for key, value in kwargs.iteritems():
            if not value is None:
                updated_values[key] = value
        
        self.populate(**updated_values)
        self.put()
    

    def create_task(self, name, **kwargs):
        task = Task(parent = self.key, name=name, **kwargs)
        task.put()
        return task
    
    def get_task(self, task_id):
        task = Task.get_by_id(task_id, parent = self.key)
        if(not task is None):
            return task
        return None
    
    def update_task(self, task_id, **kwargs):
        task = Task.get_by_id(task_id, parent = self.key)
        return task.update(**kwargs)
        
    
    def delete_task(self, task_id):
        key = ndb.Key(Task, task_id, parent = self.key)
        key.delete()
    
    def init_schedule(self):
        if self.get_schedule() is None:
            schedule = Schedule(id='recurrent', parent=self.key)
            schedule.initialize()
            schedule.put()
            self.schedule = schedule
    
    def get_schedule(self, schedule_id="recurrent"):
        if self.schedule is None:
            self.schedule = Schedule.get_by_id(schedule_id, parent=self.key)
        return self.schedule
    
    def schedule_task(self, task_id, day_id, start_offset, duration, schedule_id = "recurrent"):
        schedule = self.get_schedule(schedule_id)
        task = self.get_task(task_id)
        if task is None:
            raise BadArgumentError(" There is no task with id "+ str(task_id) + " found for this user")
        
        schedule.add_slot(task, day_id, start_offset, duration)
    
    def unschedule_task(self, schedule_id, day_id, slot_id):
        schedule = self.get_schedule(schedule_id)
        schedule.remove_slot(day_id, slot_id)
        

        
        
        
        
        
        