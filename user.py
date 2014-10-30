'''
Created on 2014-10-28

@author: didia
'''
from google.appengine.ext import ndb
from google.appengine.api.datastore_errors import BadValueError
from tracking import Schedule
from task import Task

def create_user(user_id, email, nickname):
    my_user = User(id=user_id, email=email, nickname=nickname)
    my_user.put()
    my_user.initSchedule()
    
    return my_user;

def get_user(user_id):
    return User.get_by_id(user_id)

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
    
    def initSchedule(self):
        if self.getSchedule() is None:
            schedule = Schedule(id='recurrent', parent=self.key)
            schedule.initialize()
            schedule.put()
            self.schedule = schedule
    
    def getSchedule(self):
        if self.schedule is None:
            self.schedule = Schedule.get_by_id('recurrent', parent=self.key)
        return self.schedule

        
        
        
        
        
        