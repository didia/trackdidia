'''
Created on 2014-10-28

@author: didia
'''
from google.appengine.ext import ndb

from .custom_exceptions import BadArgumentError
from .task import Task
from trackdidia.models.calendar import Week

def create_user(user_id, email, nickname):
    my_user = User(id=user_id, email=email, nickname=nickname)
    my_user.put()
    my_user.init_calendar()
    
    return my_user;

def get_user(user_id):
    return User.get_by_id(user_id)

def get_or_create_user(user_id, email, nickname):
    user = get_user(user_id)
    return user or create_user(user_id, email, nickname)

def get_all_users():
    return User.query().fetch()
    

def delete_user(user_id):
    key = ndb.Key(User, user_id)
    key.delete()
    
class User(ndb.Model):
    '''
    Stores a user information
    '''
    email = ndb.StringProperty(required=True)
    nickname = ndb.StringProperty(required=True)
    week = None
    _tasks = None
    
    
    def update(self, **kwargs):
        if not kwargs is None:
            updated_values = {}
            for key, value in kwargs.iteritems():
                if not value is None:
                    updated_values[key] = value
            
            self.populate(**updated_values)
            self.put()
    

    def create_task(self, name, **kwargs):
        self._tasks = None
        if(self.has_task(name)):
            raise BadArgumentError("A task with name < " + name + " > already exists")
        task = Task(parent = self.key, name=name, **kwargs)
        task.put()
        return task
    
    def has_task(self, task_name):
        return Task.query(ancestor = self.key).filter(Task.name ==task_name).get() != None;
                    
    def get_task(self, task_id):
        task = Task.get_by_id(task_id, parent = self.key)
        return task
    
    def get_all_tasks(self):
        if self._tasks is None:
            self._tasks = Task.query(ancestor=self.key).order(Task.name).fetch()
        return self._tasks
        
    def update_task(self, task_id, **kwargs):
        self._tasks = None
        task = Task.get_by_id(task_id, parent = self.key)
        if(kwargs.get('name') and task.name != kwargs.get('name') and 
           self.has_task(kwargs.get('name'))):
            raise BadArgumentError("A task with name < " + kwargs.get('name') + " > already exists")
            
        return task.update(**kwargs)
        
    
    def delete_task(self, task_id):
        key = ndb.Key(Task, task_id, parent = self.key)
        key.delete()
    
    def init_calendar(self):
        if self.get_week() is None:
            week = Week(id='recurrent', parent=self.key)
            week.initialize()
            week.put()
            self.week = week
        return week
    
    def get_week(self, week_id="recurrent"):
        if self.week is None:
            self.week = Week.get_by_id(week_id, parent=self.key)
        return self.week
   
    
    
    
        

        
        
        
        
        
        